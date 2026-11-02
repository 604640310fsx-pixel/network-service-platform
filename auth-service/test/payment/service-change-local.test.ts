import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import { findSellablePlan } from "../../src/payment/commerce.js";
import { createPaymentOrder, listMyOrders, retryPaymentOrder } from "../../src/payment/orders.js";
import {
  addCalendarMonths, acknowledgeServiceFulfillment, applyDueScheduledDowngrade, cancelServiceDowngrade,
  createServiceUpgradeOrder, proratedUpgradeFen, quoteServiceUpgrade,
  listServiceChangeOptions, scheduleServiceDowngrade, serviceChangeSnapshot,
} from "../../src/payment/service-change.js";
import { finalizeClosed, finalizePaid } from "../../src/payment/state-machine.js";
import { computeSessionTokenHash } from "../../src/session/session-token.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A, ACCESS_TOKEN_B, FakeAlipaySdk, TOKEN_KEYRING,
  firstValue, insertWebSession, localIspSelection, paymentDependencies,
} from "./helpers.js";
import type { DatabaseConnection } from "../../src/db.js";
import { produceRenewalQuote, renewalDryRun, setRenewalConsent } from "../../src/wallet/candidate.js";

const NOW = new Date("2026-08-21T00:00:00.000Z");
let sequence = 0;
function dependenciesFor(database: DatabaseConnection) {
  sequence += 1;
  const sdk = new FakeAlipaySdk();
  const dependencies = paymentDependencies(database,sdk,() => `${String(sequence++).padStart(8,"0")}-2222-4222-8222-222222222222`);
  return {sdk,dependencies};
}

function seedService(database: DatabaseConnection, userId: number, originalSpec: string | null = null) {
  const {dependencies,sdk} = dependenciesFor(database);
  const selection = {...localIspSelection(),specId:originalSpec};
  const monthly = findSellablePlan(database,selection);
  assert.ok(monthly);
  const order = createPaymentOrder(dependencies,{idempotencyKey:`original-${userId}-${originalSpec}`,
    rawAccessToken:ACCESS_TOKEN_A,selection,contact:"synthetic",scenarios:[],notes:null,
    acknowledgedAmountFen:monthly.priceFen,userId});
  assert.equal(finalizePaid(dependencies,{outTradeNo:order.orderRef,tradeNo:`trade-original-${userId}`,
    tradeStatus:"TRADE_SUCCESS",totalAmount:(monthly.priceFen/100).toFixed(2),totalAmountFen:monthly.priceFen,
    appId:dependencies.appId,sellerId:dependencies.sellerId}),"finalized");
  const serviceId = firstValue(database,"SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?",order.orderRef) as number;
  database.prepare("UPDATE services SET status='open',ends_at='2026-09-01T00:00:00.000Z',opened_by_admin_id=?,opened_at=?,updated_at=? WHERE id=?")
    .run(userId,"2026-08-01T00:00:00.000Z","2026-08-01T00:00:00.000Z",serviceId);
  const quota = originalSpec?.endsWith("500g") ? 500 : originalSpec?.endsWith("1t") ? 1000 : 200;
  database.prepare(`INSERT INTO service_entitlements
    (service_id,user_id,plan_id,monthly_plan_id,monthly_price_fen,period_start,period_end,period_months,
     discount_numerator,discount_denominator,usage_start,usage_end,usage_used_gb,usage_quota_gb,
     provider_binding_ref,binding_provenance,created_at,updated_at)
     VALUES (?,?,?,?,?,'2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1,1,1,
     '2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',80,?,?,'synthetic',?,?)`)
    .run(serviceId,userId,monthly.id,monthly.id,monthly.priceFen,quota,`synthetic-provider-${serviceId}`,
      NOW.toISOString(),NOW.toISOString());
  return {serviceId,order,dependencies,sdk};
}

test("calendar anniversaries and exact rational prorating keep one final half-up fen", () => {
  assert.equal(addCalendarMonths(new Date("2024-01-31T05:06:07.000Z"),1).toISOString(),"2024-02-29T05:06:07.000Z");
  assert.equal(addCalendarMonths(new Date("2025-01-31T05:06:07.000Z"),1).toISOString(),"2025-02-28T05:06:07.000Z");
  assert.equal(addCalendarMonths(new Date("2024-02-29T00:00:00.000Z"),12).toISOString(),"2025-02-28T00:00:00.000Z");
  assert.equal(proratedUpgradeFen(1000,1,1,1,1,2),500);
  assert.equal(proratedUpgradeFen(101,1,1,1,1,2),51);
  assert.equal(proratedUpgradeFen(1000,6,85,100,1,2),2550);
  assert.equal(proratedUpgradeFen(1000,12,74,100,1,2),4440);
  assert.equal(proratedUpgradeFen(1000,12,74,100,100,100),8880);
  assert.throws(() => proratedUpgradeFen(1000,6,90,100,1,2),/service_not_quotable/);
});

test("renewal quote follows fulfilled effective route and quota, keeps term discounts and rejects inconsistent bindings", async () => {
  await withAuthenticationDatabase(async (database) => {
    const owner = insertAuthenticationUser(database,{email:"renewal-effective@example.test",passwordHash:"synthetic",status:"active"});
    const other = insertAuthenticationUser(database,{email:"renewal-other@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,owner);
    database.prepare("UPDATE services SET ends_at='2026-09-01T00:00:00.000Z' WHERE id=?").run(seeded.serviceId);
    const baseline = produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner);
    const rights = () => firstValue(database,"SELECT usage_used_gb FROM service_entitlements WHERE service_id=?",seeded.serviceId);
    const quote = quoteServiceUpgrade(database,owner,seeded.serviceId,"high-500g",NOW);
    const order = createServiceUpgradeOrder(seeded.dependencies,{userId:owner,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"renewal-effective-upgrade",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:quote.amountFen});
    assert.equal(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key,baseline.key);
    assert.equal(finalizePaid(seeded.dependencies,{outTradeNo:order.orderRef,tradeNo:"renewal-effective-paid",
      tradeStatus:"TRADE_SUCCESS",totalAmount:(quote.amountFen/100).toFixed(2),totalAmountFen:quote.amountFen,
      appId:seeded.dependencies.appId,sellerId:seeded.dependencies.sellerId}),"finalized");
    assert.equal(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key,baseline.key);
    acknowledgeServiceFulfillment(database,owner,seeded.serviceId,"renewal-effective-ack",true,NOW);
    const entitlement = serviceChangeSnapshot(database,seeded.serviceId,owner,NOW);
    assert.equal(entitlement?.specId,"high-500g");
    assert.equal(entitlement?.usageQuotaGb,500);
    assert.equal(entitlement?.usageUsedGb,80);
    for (const [period,durationId] of [["MONTHLY","month-1"],["SEMIANNUAL","month-6"],["ANNUAL","month-12"]] as const) {
      const plan = findSellablePlan(database,{...localIspSelection(),specId:"high-500g",durationId});
      assert.ok(plan);
      const renewal = produceRenewalQuote(database,seeded.serviceId,period,owner);
      assert.equal(renewal.priceFen,plan.priceFen);
      assert.ok(renewal.key.includes(":high-500g:"));
      assert.equal(renewal.previousEndsAt,"2026-09-01T00:00:00.000Z");
    }
    const effectiveKey = produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key;
    scheduleServiceDowngrade(database,owner,seeded.serviceId,"half-500g",NOW);
    assert.notEqual(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key,effectiveKey);
    assert.ok(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key.includes(":half-500g:"));
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,owner,NOW)?.specId,"high-500g");
    assert.equal(rights(),80);
    cancelServiceDowngrade(database,owner,seeded.serviceId,NOW);
    assert.equal(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key,effectiveKey);
    assert.throws(() => produceRenewalQuote(database,seeded.serviceId,"MONTHLY",other),/FORBIDDEN/);
    database.prepare("UPDATE service_entitlements SET user_id=? WHERE service_id=?").run(other,seeded.serviceId);
    assert.throws(() => produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner),/QUOTE_UNAVAILABLE/);
    database.prepare("UPDATE service_entitlements SET user_id=? WHERE service_id=?").run(owner,seeded.serviceId);
    const wrong = findSellablePlan(database,{...localIspSelection(),ispId:"us-att",specId:"high-500g"});
    assert.ok(wrong);
    database.prepare("UPDATE service_entitlements SET plan_id=? WHERE service_id=?").run(wrong.id,seeded.serviceId);
    assert.throws(() => produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner),/QUOTE_UNAVAILABLE/);
    database.prepare("DELETE FROM service_entitlements WHERE service_id=?").run(seeded.serviceId);
    assert.equal(produceRenewalQuote(database,seeded.serviceId,"MONTHLY",owner).key,baseline.key);
  });
});

test("scheduled next-paid quote selects target without current-right or consent escalation; local due apply is exact and idempotent", async (t) => {
  await withAuthenticationDatabase(async (database) => {
    const owner = insertAuthenticationUser(database,{email:"scheduled-due@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,owner,"high-500g");
    const serviceId = seeded.serviceId;
    const before = database.prepare("SELECT * FROM service_entitlements WHERE service_id=?").all(serviceId)[0] as Record<string,unknown>;
    const originalQuote = produceRenewalQuote(database,serviceId,"MONTHLY",owner);
    setRenewalConsent(database,serviceId,owner,"MONTHLY",0,true,originalQuote.key,NOW.toISOString());
    const consentBefore = database.prepare("SELECT * FROM wallet_consents WHERE service_id=?").all(serviceId);
    const financialBefore = () => ["payments","orders","wallet_ledger","wallet_renewal_cycles"].map(table =>
      firstValue(database,`SELECT COUNT(*) FROM ${table}`));
    const financial = financialBefore();
    scheduleServiceDowngrade(database,owner,serviceId,"half-500g",NOW);
    const changeId = firstValue(database,"SELECT id FROM service_changes WHERE service_id=? AND status='scheduled'",serviceId) as number;
    for (const [period,durationId] of [["MONTHLY","month-1"],["SEMIANNUAL","month-6"],["ANNUAL","month-12"]] as const) {
      const next = produceRenewalQuote(database,serviceId,period,owner);
      const target = findSellablePlan(database,{...localIspSelection(),specId:"half-500g",durationId});
      assert.ok(target);
      assert.ok(next.key.includes(":half-500g:"));
      assert.equal(next.priceFen,target.priceFen);
      assert.equal(next.previousEndsAt,before.period_end);
    }
    const nextQuote = produceRenewalQuote(database,serviceId,"MONTHLY",owner);
    assert.equal(renewalDryRun(database,{serviceId,ownerId:owner,purchased:true,endsAt:before.period_end as string},nextQuote),"RECONSENT_REQUIRED");
    assert.deepEqual(database.prepare("SELECT * FROM wallet_consents WHERE service_id=?").all(serviceId),consentBefore);
    assert.deepEqual(database.prepare("SELECT * FROM service_entitlements WHERE service_id=?").all(serviceId)[0],before);
    assert.throws(() => applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,serviceId,changeId,new Date("2026-08-31T23:59:59.999Z")),/change_not_due/);
    const due = new Date("2026-09-01T00:00:00.000Z");
    assert.deepEqual(applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,serviceId,changeId,due),{status:"applied",replay:false});
    const after = database.prepare("SELECT * FROM service_entitlements WHERE service_id=?").all(serviceId)[0] as Record<string,unknown>;
    const target = findSellablePlan(database,{...localIspSelection(),specId:"half-500g"});
    assert.ok(target);
    assert.equal(after.plan_id,target.id);assert.equal(after.monthly_plan_id,target.id);
    assert.equal(after.monthly_price_fen,target.priceFen);assert.equal(after.version,(before.version as number)+1);
    for (const key of Object.keys(before).filter(key => !["plan_id","monthly_plan_id","monthly_price_fen","version","updated_at"].includes(key))) {
      assert.equal(after[key],before[key],key);
    }
    assert.equal(firstValue(database,"SELECT ends_at FROM services WHERE id=?",serviceId),before.period_end);
    assert.deepEqual(applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,serviceId,changeId,due),{status:"applied",replay:true});
    assert.deepEqual(database.prepare("SELECT * FROM service_entitlements WHERE service_id=?").all(serviceId)[0],after);
    assert.ok(produceRenewalQuote(database,serviceId,"MONTHLY",owner).key.includes(":half-500g:"));
    assert.throws(() => acknowledgeServiceFulfillment(database,owner,serviceId,"not-upgrade-ack",true,due),/no_paid_change/);
    assert.deepEqual(financialBefore(),financial);
    assert.deepEqual(database.prepare("SELECT * FROM wallet_consents WHERE service_id=?").all(serviceId),consentBefore);
    t.diagnostic(JSON.stringify({case:"local-scheduled-due",earlyClock:"2026-08-31T23:59:59.999Z",dueClock:due.toISOString(),
      before,after,nextQuote,consentBefore,consentAfter:database.prepare("SELECT * FROM wallet_consents WHERE service_id=?").all(serviceId),
      financialBefore:financial,financialAfter:financialBefore(),repeat:"replay:true; no second write",mode:"LOCAL_DEMO_ONLY"}));
  });
});

test("scheduled target contradictions fail closed; cancellation restores current quote and forbids due apply", async () => {
  await withAuthenticationDatabase(async (database) => {
    const owner = insertAuthenticationUser(database,{email:"scheduled-invalid@example.test",passwordHash:"synthetic",status:"active"});
    const outsider = insertAuthenticationUser(database,{email:"scheduled-outsider@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,owner,"high-500g");
    const serviceId=seeded.serviceId;
    const current=produceRenewalQuote(database,serviceId,"MONTHLY",owner);
    scheduleServiceDowngrade(database,owner,serviceId,"half-500g",NOW);
    const changeId=firstValue(database,"SELECT id FROM service_changes WHERE service_id=? AND status='scheduled'",serviceId) as number;
    const due=new Date("2026-09-01T00:00:00.000Z");
    const rejects=()=>{
      assert.throws(()=>produceRenewalQuote(database,serviceId,"MONTHLY",owner),/QUOTE_UNAVAILABLE|SERVICE_CLOSED/);
      assert.throws(()=>applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,serviceId,changeId,due));
      assert.equal(firstValue(database,"SELECT status FROM service_changes WHERE id=?",changeId),"scheduled");
    };
    for (const [field,bad] of [["user_id",outsider],["from_version",99],["effective_at","2026-10-01T00:00:00.000Z"],["target_monthly_fen",1]] as const) {
      const prior=firstValue(database,`SELECT ${field} FROM service_changes WHERE id=?`,changeId);
      database.prepare(`UPDATE service_changes SET ${field}=? WHERE id=?`).run(bad,changeId);
      rejects();database.prepare(`UPDATE service_changes SET ${field}=? WHERE id=?`).run(prior,changeId);
    }
    const plan=firstValue(database,"SELECT target_plan_id FROM service_changes WHERE id=?",changeId) as number;
    database.prepare("UPDATE sellable_plans SET is_active=0 WHERE id=?").run(plan);
    rejects();database.prepare("UPDATE sellable_plans SET is_active=1 WHERE id=?").run(plan);
    const halfYear=findSellablePlan(database,{...localIspSelection(),specId:"half-500g",durationId:"month-6"});
    assert.ok(halfYear);
    database.prepare("UPDATE sellable_plans SET total_slots=occupied_slots WHERE id=?").run(halfYear.id);
    assert.throws(()=>produceRenewalQuote(database,serviceId,"SEMIANNUAL",owner),/QUOTE_UNAVAILABLE/);
    database.prepare("UPDATE sellable_plans SET total_slots=NULL WHERE id=?").run(halfYear.id);
    const wrong=findSellablePlan(database,{...localIspSelection(),ispId:"us-att",specId:"half-500g"});
    assert.ok(wrong);
    database.prepare("UPDATE service_changes SET target_plan_id=? WHERE id=?").run(wrong.id,changeId);
    rejects();database.prepare("UPDATE service_changes SET target_plan_id=? WHERE id=?").run(plan,changeId);
    const opening=database.prepare("SELECT opened_at,opened_by_admin_id FROM services WHERE id=?").all(serviceId)[0] as Record<string,unknown>;
    database.prepare("UPDATE services SET status='pending_open',opened_at=NULL,opened_by_admin_id=NULL WHERE id=?").run(serviceId);
    rejects();database.prepare("UPDATE services SET status='open',opened_at=?,opened_by_admin_id=? WHERE id=?")
      .run(opening.opened_at,opening.opened_by_admin_id,serviceId);
    for (const [table,field,bad,good] of [["services","ends_at","2026-10-01T00:00:00.000Z","2026-09-01T00:00:00.000Z"],
      ["payments","status","pending","paid"],["orders","status","pending","paid"]] as const) {
      const id=table==="services"?serviceId:table==="payments"
        ? firstValue(database,"SELECT payment_id FROM services WHERE id=?",serviceId)
        : firstValue(database,"SELECT p.order_id FROM services s JOIN payments p ON p.id=s.payment_id WHERE s.id=?",serviceId);
      if (table==="payments") {
        const paidAt=firstValue(database,"SELECT paid_at FROM payments WHERE id=?",id);
        database.prepare("UPDATE payments SET status='pending',paid_at=NULL WHERE id=?").run(id);
        rejects();database.prepare("UPDATE payments SET status='paid',paid_at=? WHERE id=?").run(paidAt,id);
      } else {
        database.prepare(`UPDATE ${table} SET ${field}=? WHERE id=?`).run(bad,id);
        rejects();database.prepare(`UPDATE ${table} SET ${field}=? WHERE id=?`).run(good,id);
      }
    }
    database.prepare(`INSERT INTO service_changes(service_id,user_id,kind,status,from_version,target_plan_id,
      target_monthly_plan_id,target_monthly_fen,amount_fen,effective_at,created_at,updated_at)
      SELECT service_id,user_id,kind,'paid_conflict',from_version,target_plan_id,target_monthly_plan_id,
      target_monthly_fen,amount_fen,effective_at,created_at,updated_at FROM service_changes WHERE id=?`).run(changeId);
    rejects();database.prepare("DELETE FROM service_changes WHERE service_id=? AND status='paid_conflict'").run(serviceId);
    database.prepare("INSERT INTO wallet_termination_cases(service_id,requested_at,requested_by,stop_state) VALUES (?,?,?,'REQUESTED')")
      .run(serviceId,NOW.toISOString(),owner);
    rejects();database.prepare("DELETE FROM wallet_termination_cases WHERE service_id=?").run(serviceId);
    assert.throws(()=>applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",outsider,serviceId,changeId,due),/no_scheduled_downgrade/);
    assert.throws(()=>applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,99999,changeId,due),/no_scheduled_downgrade/);
    cancelServiceDowngrade(database,owner,serviceId,NOW);
    assert.equal(produceRenewalQuote(database,serviceId,"MONTHLY",owner).key,current.key);
    assert.throws(()=>applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",owner,serviceId,changeId,due),/no_scheduled_downgrade/);
  });
});

test("upgrade links its paid order to the original service; fulfillment failure preserves rights and retry applies once", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-a@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId);
    const quote = quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW);
    assert.equal(quote.amountFen,Math.floor((2000*11*24*60*60*1000/(31*24*60*60*1000))+.5));
    const changeOrder = createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"change-key",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:quote.amountFen});
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_changes WHERE service_id=?",seeded.serviceId),1);
    assert.equal(createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"change-key",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:quote.amountFen}).orderRef,
      changeOrder.orderRef);
    assert.throws(() => createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"change-key",rawAccessToken:ACCESS_TOKEN_A,acknowledgedAmountFen:quote.amountFen}),/idempotency_key_conflict/);
    const event = {outTradeNo:changeOrder.orderRef,tradeNo:"trade-change",tradeStatus:"TRADE_SUCCESS",
      totalAmount:(quote.amountFen/100).toFixed(2),totalAmountFen:quote.amountFen,appId:seeded.dependencies.appId,sellerId:seeded.dependencies.sellerId};
    assert.equal(finalizePaid(seeded.dependencies,event),"finalized");
    assert.equal(finalizePaid(seeded.dependencies,event),"idempotent_replay");
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,NOW)?.usageUsedGb,80);
    assert.equal(acknowledgeServiceFulfillment(database,userId,seeded.serviceId,"failure-001",false,NOW).status,"fulfillment_failed");
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,NOW)?.specId,null);
    assert.equal(acknowledgeServiceFulfillment(database,userId,seeded.serviceId,"success-001",true,NOW).status,"applied");
    assert.equal(acknowledgeServiceFulfillment(database,userId,seeded.serviceId,"success-001",true,NOW).replay,true);
    const effective = serviceChangeSnapshot(database,seeded.serviceId,userId,NOW);
    assert.equal(effective?.specId,"high-200g");
    assert.equal(effective?.usageUsedGb,80);
    assert.equal(effective?.usageWindowEnd,"2026-09-01T00:00:00.000Z");
    assert.equal(effective?.periodEnd,"2026-09-01T00:00:00.000Z");
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM payments"),2);
    scheduleServiceDowngrade(database,userId,seeded.serviceId,"half-200g",NOW);
    const downgradeId=firstValue(database,"SELECT id FROM service_changes WHERE service_id=? AND status='scheduled'",seeded.serviceId) as number;
    applyDueScheduledDowngrade(database,"LOCAL_DEMO_ONLY",userId,seeded.serviceId,downgradeId,new Date("2026-09-01T00:00:00.000Z"));
    assert.equal(acknowledgeServiceFulfillment(database,userId,seeded.serviceId,"success-001",true,new Date("2026-09-01T00:00:00.000Z")).replay,true);
  });
});

test("historical data stays nonquotable; scheduled downgrade is inert, cancellable, and blocks another change", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-b@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId,"high-200g");
    const second = insertAuthenticationUser(database,{email:"other@example.test",passwordHash:"synthetic",status:"active"});
    assert.throws(() => quoteServiceUpgrade(database,second,seeded.serviceId,"live-1t",NOW),/service_not_found/);
    const schedule = scheduleServiceDowngrade(database,userId,seeded.serviceId,null,NOW);
    assert.equal(schedule.amountFen,0);
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,NOW)?.specId,"high-200g");
    const periodEnd = new Date("2026-09-01T00:00:00.000Z");
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,periodEnd),null);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM payments"),1);
    assert.equal(firstValue(database,"SELECT period_end FROM service_entitlements WHERE service_id=?",seeded.serviceId),periodEnd.toISOString());
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"live-1t",NOW),/change_already_pending/);
    assert.equal(cancelServiceDowngrade(database,userId,seeded.serviceId,NOW).status,"cancelled");
    assert.ok(quoteServiceUpgrade(database,userId,seeded.serviceId,"live-1t",NOW).amountFen>0);
    database.prepare("DELETE FROM service_entitlements WHERE service_id=?").run(seeded.serviceId);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"live-1t",NOW),/service_not_found/);
  });
});

test("authenticated local demo routes reject anonymous, other owner and CSRF mismatch", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-c@example.test",passwordHash:"synthetic",status:"active"});
    const otherId = insertAuthenticationUser(database,{email:"change-d@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId);
    const other = insertWebSession(database,otherId);
    const csrf = issueCsrfToken(seeded.dependencies.csrfSigningKey,computeSessionTokenHash(other.rawToken,TOKEN_KEYRING).tokenHash);
    const app = buildApp({payment:{...seeded.dependencies,serviceChangeLocalDemo:true}});
    try {
      const url = `/api/me/services/${seeded.serviceId}/change/quote`;
      const anonymous = await app.inject({method:"POST",url,payload:{specId:"high-200g"}});
      assert.equal(anonymous.statusCode,401);
      const csrfMissing = await app.inject({method:"POST",url,headers:{cookie:other.cookie},payload:{specId:"high-200g"}});
      assert.equal(csrfMissing.statusCode,403);
      const wrongOwner = await app.inject({method:"POST",url,headers:{cookie:other.cookie,"x-csrf-token":csrf},payload:{specId:"high-200g"}});
      assert.equal(wrongOwner.statusCode,404);
      assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_change_quotes"),0);
    } finally { await app.close(); }
  });
});

test("schema 030 missing its change table fails closed instead of using legacy fulfillment", async () => {
  await withAuthenticationDatabase(async (database) => {
    const owner = insertAuthenticationUser(database,{email:"missing-table@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,owner);
    database.exec("DROP TABLE service_changes");
    assert.throws(()=>finalizePaid(seeded.dependencies,{outTradeNo:seeded.order.orderRef,tradeNo:`trade-original-${owner}`,
      tradeStatus:"TRADE_SUCCESS",totalAmount:"79.00",totalAmountFen:7900,
      appId:seeded.dependencies.appId,sellerId:seeded.dependencies.sellerId}),/Service change schema invariant failed/);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM payments"),1);
  });
});

test("quote rejects stale usage/version, missing binding and nonstandard discount; six-month calendar snapshot is honored", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-e@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId);
    const quote = quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW);
    database.prepare("UPDATE service_entitlements SET usage_version=usage_version+1 WHERE service_id=?").run(seeded.serviceId);
    assert.throws(() => createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"stale-key",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:quote.amountFen}),/stale_change_quote/);
    assert.throws(() => database.prepare("UPDATE service_entitlements SET provider_binding_ref='' WHERE service_id=?").run(seeded.serviceId));
    database.prepare("UPDATE service_entitlements SET discount_numerator=90 WHERE service_id=?")
      .run(seeded.serviceId);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW),/service_not_quotable/);
    const periodPlan = findSellablePlan(database,{...localIspSelection(),durationId:"month-6"});
    assert.ok(periodPlan);
    database.prepare(`UPDATE orders SET duration_id='month-6' WHERE id=(SELECT p.order_id FROM payments p JOIN services s ON s.payment_id=p.id WHERE s.id=?)`)
      .run(seeded.serviceId);
    database.prepare(`UPDATE service_entitlements SET plan_id=?,period_start='2026-02-28T00:00:00.000Z',
      period_end='2026-08-28T00:00:00.000Z',period_months=6,discount_numerator=85,discount_denominator=100,
      usage_start='2026-07-28T00:00:00.000Z',usage_end='2026-08-28T00:00:00.000Z' WHERE service_id=?`)
      .run(periodPlan.id,seeded.serviceId);
    database.prepare("UPDATE services SET ends_at='2026-08-28T00:00:00.000Z' WHERE id=?").run(seeded.serviceId);
    database.prepare(`UPDATE service_entitlements SET usage_start='2026-02-28T00:00:00.000Z' WHERE service_id=?`)
      .run(seeded.serviceId);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW),/service_not_quotable/);
    database.prepare(`UPDATE service_entitlements SET usage_start='2026-07-28T00:00:00.000Z' WHERE service_id=?`)
      .run(seeded.serviceId);
    const half = quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW);
    assert.equal(half.amountFen,proratedUpgradeFen(2000,6,85,100,
      new Date("2026-08-28T00:00:00.000Z").getTime()-NOW.getTime(),
      new Date("2026-08-28T00:00:00.000Z").getTime()-new Date("2026-02-28T00:00:00.000Z").getTime()));
    const yearPlan = findSellablePlan(database,{...localIspSelection(),durationId:"month-12"});
    const targetYear = findSellablePlan(database,{...localIspSelection(),specId:"half-200g",durationId:"month-12"});
    assert.ok(yearPlan && targetYear);
    assert.equal(targetYear.priceFen-yearPlan.priceFen,8800); // New-purchase whole-yuan period rounding is different.
    database.prepare(`UPDATE orders SET duration_id='month-12' WHERE id=(SELECT p.order_id FROM payments p JOIN services s ON s.payment_id=p.id WHERE s.id=?)`)
      .run(seeded.serviceId);
    database.prepare(`UPDATE service_entitlements SET plan_id=?,period_start='2026-01-31T00:00:00.000Z',
      period_end='2027-01-31T00:00:00.000Z',period_months=12,discount_numerator=74,discount_denominator=100,
      usage_start='2026-07-31T00:00:00.000Z',usage_end='2026-08-31T00:00:00.000Z' WHERE service_id=?`)
      .run(yearPlan.id,seeded.serviceId);
    database.prepare("UPDATE services SET ends_at='2027-01-31T00:00:00.000Z' WHERE id=?").run(seeded.serviceId);
    const year = quoteServiceUpgrade(database,userId,seeded.serviceId,"half-200g",NOW);
    assert.equal(year.amountFen,proratedUpgradeFen(1000,12,74,100,
      new Date("2027-01-31T00:00:00.000Z").getTime()-NOW.getTime(),
      new Date("2027-01-31T00:00:00.000Z").getTime()-new Date("2026-01-31T00:00:00.000Z").getTime()));
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM orders"),1);
  });
});

test("late authoritative success after closed change never inserts a second service, even with a newer pending change", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-f@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId);
    const first = quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW);
    const order = createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:first.quoteRef,idempotencyKey:"first-closed",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:first.amountFen});
    const closed = {outTradeNo:order.orderRef,tradeNo:"trade-late",tradeStatus:"TRADE_CLOSED",totalAmount:(first.amountFen/100).toFixed(2),
      totalAmountFen:first.amountFen,appId:seeded.dependencies.appId,sellerId:seeded.dependencies.sellerId};
    assert.equal(finalizeClosed(seeded.dependencies,closed),"finalized");
    assert.throws(() => retryPaymentOrder(seeded.dependencies,{oldOrderRef:order.orderRef,idempotencyKey:"generic-retry-denied",
      oldRawAccessToken:null,newRawAccessToken:Buffer.alloc(32,0x56).toString("base64url"),currentUserId:userId}),
      /service_change_retry_not_supported/);
    assert.equal(listMyOrders(database,userId).length,1); // Original purchase only; change is tracked on its service.
    const second = quoteServiceUpgrade(database,userId,seeded.serviceId,"live-200g",NOW);
    createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:second.quoteRef,idempotencyKey:"second-pending",rawAccessToken:Buffer.alloc(32,0x55).toString("base64url"),
      acknowledgedAmountFen:second.amountFen});
    assert.equal(finalizePaid(seeded.dependencies,{...closed,tradeStatus:"TRADE_SUCCESS"}),"finalized");
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_changes WHERE status='paid_conflict'"),1);
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,NOW)?.paidConflict,true);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"high-500g",NOW),/change_already_pending/);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_changes WHERE status='pending_payment'"),1);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_entitlements WHERE version=1"),1);
  });
});

test("service-change signed notify rejects invalid signature, then confirms once without creating a service", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-g@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId);
    const quote = quoteServiceUpgrade(database,userId,seeded.serviceId,"high-200g",NOW);
    const order = createServiceUpgradeOrder(seeded.dependencies,{userId,serviceId:seeded.serviceId,
      quoteRef:quote.quoteRef,idempotencyKey:"notify-change",rawAccessToken:ACCESS_TOKEN_B,acknowledgedAmountFen:quote.amountFen});
    const fields = {sign:"synthetic-signature",sign_type:"RSA2",notify_id:"change-notify-1",
      app_id:seeded.dependencies.appId,seller_id:seeded.dependencies.sellerId,
      out_trade_no:order.orderRef,trade_no:"trade-notify-change",trade_status:"TRADE_SUCCESS",
      total_amount:(quote.amountFen/100).toFixed(2)};
    const app = buildApp({payment:seeded.dependencies});
    try {
      seeded.sdk.verifyNotify=false;
      const headers={"content-type":"application/x-www-form-urlencoded"};
      const payload = new URLSearchParams(fields).toString();
      assert.equal((await app.inject({method:"POST",url:"/api/pay/alipay/notify",headers,payload})).body,"failure");
      assert.equal(firstValue(database,"SELECT status FROM orders WHERE order_ref=?",order.orderRef),"pending");
      seeded.sdk.verifyNotify=true;
      assert.equal((await app.inject({method:"POST",url:"/api/pay/alipay/notify",headers,payload})).body,"success");
      assert.equal((await app.inject({method:"POST",url:"/api/pay/alipay/notify",headers,payload})).body,"success");
      assert.equal(firstValue(database,"SELECT COUNT(*) FROM services"),1);
      assert.equal(firstValue(database,"SELECT status FROM service_changes WHERE order_id=(SELECT id FROM orders WHERE order_ref=?)",order.orderRef),
        "pending_fulfillment");
      assert.equal(firstValue(database,"SELECT COUNT(*) FROM payment_notifications WHERE out_trade_no=?",order.orderRef),1);
    } finally { await app.close(); }
  });
});

test("a dearer line cannot disguise a lower monthly flow quota as an upgrade", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-h@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId,"ordinary-1t");
    assert.equal(serviceChangeSnapshot(database,seeded.serviceId,userId,NOW)?.usageQuotaGb,1000);
    const targetPlan = findSellablePlan(database,{...localIspSelection(),specId:"live-200g"});
    assert.ok(targetPlan);
    assert.ok(targetPlan.priceFen > 9900);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"live-200g",NOW),/invalid_change_target/);
    assert.throws(() => scheduleServiceDowngrade(database,userId,seeded.serviceId,"half-200g",NOW),/invalid_change_target/);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_changes"),0);
  });
});

test("lower line with higher monthly flow cannot be combined into one immediate change", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database,{email:"change-mixed@example.test",passwordHash:"synthetic",status:"active"});
    const seeded = seedService(database,userId,"high-200g");
    const mixed = findSellablePlan(database,{...localIspSelection(),specId:"half-1t"});
    assert.ok(mixed && mixed.priceFen > 9900);
    assert.throws(() => quoteServiceUpgrade(database,userId,seeded.serviceId,"half-1t",NOW),/invalid_change_target/);
    assert.throws(() => scheduleServiceDowngrade(database,userId,seeded.serviceId,"half-1t",NOW),/invalid_change_target/);
    assert.equal(listServiceChangeOptions(database,userId,seeded.serviceId,NOW).some((item) => item.specId === "half-1t"),false);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_change_quotes"),0);
    assert.equal(firstValue(database,"SELECT COUNT(*) FROM service_changes"),0);
  });
});

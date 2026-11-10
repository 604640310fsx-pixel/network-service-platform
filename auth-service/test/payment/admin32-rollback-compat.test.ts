import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPassword } from "../../src/auth/password.js";
import { initializeDatabase } from "../../src/db.js";
import { isDirectoryEnabled, updateCatalogDirectoryStatus } from "../../src/payment/catalog-directory.js";
import { PaymentDomainError, resolveQuote } from "../../src/payment/commerce.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { scheduleServiceDowngrade } from "../../src/payment/service-change.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { loginAndCreateSession } from "../../src/session/login-session.js";
import { insertAuthenticationUser } from "../auth/helpers.js";
import { TOKEN_KEYRING, paymentDependencies } from "./helpers.js";

const NOW = new Date("2026-11-10T08:00:00.000Z");
const selection = { typeId:"local-isp", regionId:"us", ispId:"us-verizon", specId:"high-200g", durationId:"month-1" };

// This exercises the forward Auth binary against the same changed DB. It is
// restart/data compatibility evidence, not an independently built rollback artifact.
test("forward 032-aware Auth reopens a changed synthetic DB without losing rights or reopening sales", async () => {
  const directory=mkdtempSync(join(tmpdir(),"admin32-compat-"));
  const path=join(directory,"synthetic.sqlite");
  let database=initializeDatabase(path);
  try {
    const hash=await hashPassword("synthetic-password-only");
    const adminId=insertAuthenticationUser(database,{email:"admin@synthetic.invalid",passwordHash:hash,status:"active",role:"admin"});
    const userId=insertAuthenticationUser(database,{email:"buyer@synthetic.invalid",passwordHash:hash,status:"active"});
    const newUserId=insertAuthenticationUser(database,{email:"new@synthetic.invalid",passwordHash:hash,status:"active"});
    await loginAndCreateSession(database,"buyer@synthetic.invalid","synthetic-password-only",TOKEN_KEYRING,{now:()=>NOW});
    let sequence=0;
    const dependencies=paymentDependencies(database,undefined,()=>`${String(++sequence).padStart(8,"0")}-2222-4222-8222-222222222222`);
    const quote=resolveQuote(database,{selection,couponCode:null,now:()=>NOW});
    const orderInput=(id:number)=>({idempotencyKey:`synthetic-compat-${id}`,
      rawAccessToken:Buffer.alloc(32,id).toString("base64url"),selection,contact:"synthetic",scenarios:[],notes:null,
      acknowledgedAmountFen:quote.amountFen,userId});
    const paid=createPaymentOrder(dependencies,orderInput(1));
    const pending=createPaymentOrder(dependencies,orderInput(2));
    finalizePaid(dependencies,{outTradeNo:paid.orderRef,tradeNo:"synthetic-trade-1",tradeStatus:"TRADE_SUCCESS",
      totalAmount:(quote.amountFen/100).toFixed(2),totalAmountFen:quote.amountFen,
      appId:dependencies.appId,sellerId:dependencies.sellerId});
    const service=database.prepare(`SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id
      WHERE p.out_trade_no=?`).all(paid.orderRef)[0] as {id:number};
    database.prepare("UPDATE services SET status='open', ends_at='2026-12-01T00:00:00.000Z', opened_by_admin_id=?, opened_at=?, updated_at=? WHERE id=?")
      .run(adminId,NOW.toISOString(),NOW.toISOString(),service.id);
    const planId=quote.planId;
    database.prepare(`INSERT INTO service_entitlements (service_id,user_id,plan_id,monthly_plan_id,monthly_price_fen,
      period_start,period_end,period_months,discount_numerator,discount_denominator,usage_start,usage_end,
      usage_used_gb,usage_quota_gb,provider_binding_ref,binding_provenance,created_at,updated_at)
      VALUES (?,?,?,?,?,'2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',1,1,1,
        '2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',80,200,'synthetic-binding','synthetic',?,?)`)
      .run(service.id,userId,planId,planId,quote.listPriceFen,NOW.toISOString(),NOW.toISOString());
    scheduleServiceDowngrade(database,userId,service.id,"half-200g",NOW);
    updateCatalogDirectoryStatus(database,{kind:"operator",typeId:"local-isp",regionId:"us",ispId:"us-verizon",
      isActive:false,adminUserId:adminId,now:()=>NOW});
    const before={
      users:database.prepare("SELECT id,email,last_successful_web_login_at FROM users ORDER BY id").all(),
      orders:database.prepare("SELECT order_ref,status,amount_fen FROM orders ORDER BY id").all(),
      changes:database.prepare("SELECT service_id,status,target_plan_id FROM service_changes ORDER BY id").all(),
      price:database.prepare("SELECT price_fen,is_active,occupied_slots FROM sellable_plans WHERE id=?").all(planId),
    };
    assert.deepEqual(before.orders.map((row)=> (row as {status:string}).status),["paid","pending"]);
    assert.equal((before.users.find((row)=>(row as {id:number}).id===newUserId) as {email:string}).email,"new@synthetic.invalid");
    assert.equal((before.users.find((row)=>(row as {id:number}).id===userId) as {last_successful_web_login_at:string}).last_successful_web_login_at,NOW.toISOString());
    assert.equal((before.changes[0] as {status:string}).status,"scheduled");
    database.close();
    database=initializeDatabase(path); // Same post-migration DB; no snapshot replacement.
    assert.equal((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").all()[0] as {version:number}).version,32);
    assert.deepEqual(database.prepare("SELECT id,email,last_successful_web_login_at FROM users ORDER BY id").all(),before.users);
    assert.deepEqual(database.prepare("SELECT order_ref,status,amount_fen FROM orders ORDER BY id").all(),before.orders);
    assert.deepEqual(database.prepare("SELECT service_id,status,target_plan_id FROM service_changes ORDER BY id").all(),before.changes);
    assert.deepEqual(database.prepare("SELECT price_fen,is_active,occupied_slots FROM sellable_plans WHERE id=?").all(planId),before.price);
    assert.equal(isDirectoryEnabled(database,"local-isp","us","us-verizon"),false);
    assert.throws(()=>resolveQuote(database,{selection,couponCode:null,now:()=>NOW}),
      (error:unknown)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
    assert.throws(()=>createPaymentOrder(paymentDependencies(database),{...orderInput(3),
      rawAccessToken:Buffer.alloc(32,3).toString("base64url")}),
      (error:unknown)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM orders").all()[0] as {n:number}).n,2);
    assert.equal(pending.status,"pending");
  } finally { database.close(); rmSync(directory,{recursive:true,force:true}); }
});

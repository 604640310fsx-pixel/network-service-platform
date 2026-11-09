import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { initializeDatabase } from "../dist/src/db.js";
import { hashPassword } from "../dist/src/auth/password.js";
import { insertAuthenticationUser } from "../dist/test/auth/helpers.js";
import { TOKEN_KEYRING, CSRF_KEY, paymentDependencies } from "../dist/test/payment/helpers.js";
import { loginAndCreateSession } from "../dist/src/session/login-session.js";
import { resolveQuote } from "../dist/src/payment/commerce.js";
import { createPaymentOrder } from "../dist/src/payment/orders.js";
import { finalizePaid } from "../dist/src/payment/state-machine.js";
import { scheduleServiceDowngrade } from "../dist/src/payment/service-change.js";
import { updateCatalogDirectoryStatus } from "../dist/src/payment/catalog-directory.js";

const candidate = resolve(process.argv[2] ?? "");
if (!/(?:admin32-rollback|\.codex-admin-rollback)/.test(candidate) || candidate === resolve(""))
  throw new Error("Expected task-isolated 381-derived rollback build path");
const rollback = async (path) => import(pathToFileURL(join(candidate, "dist/src", path)).href);
const { openRollbackDatabase32, prepareDatabaseReadinessProbe } = await rollback("db.js");
const { buildApp } = await rollback("app.js");
const { resolveQuote: rollbackQuote, PaymentDomainError } = await rollback("payment/commerce.js");
const { createPaymentOrder: rollbackOrder } = await rollback("payment/orders.js");
const { loginAndCreateSession: rollbackLogin } = await rollback("session/login-session.js");
const now = new Date("2026-11-10T08:00:00.000Z");
const selection = {typeId:"local-isp",regionId:"us",ispId:"us-verizon",specId:"high-200g",durationId:"month-1"};
const root = mkdtempSync(join(tmpdir(),"admin32-independent-rollback-"));

function assertRejectsLedger(last, missingVersion = null) {
  const path = join(root,`ledger-${last}-${missingVersion ?? "complete"}.sqlite`);
  const db = new Database(path);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('synthetic-unchanged');");
  const put = db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)");
  for (let version=1;version<=last;version++) if(version!==missingVersion) put.run(version,now.toISOString());
  const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  db.close();
  assert.throws(()=>openRollbackDatabase32(path),/exact existing 001-032 ledger/);
  const after = new Database(path,{readonly:true});
  try {
    assert.deepEqual(after.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),before);
    assert.deepEqual(after.prepare("SELECT * FROM marker").all(),[{value:"synthetic-unchanged"}]);
    assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='sellable_regions'").all().length,0);
  } finally { after.close(); }
}

let forward;
let recovered;
let app;
try {
  assertRejectsLedger(31);
  assertRejectsLedger(33);
  assertRejectsLedger(32,16);
  const missingLedger=join(root,"missing-ledger.sqlite");
  const empty=new Database(missingLedger);
  empty.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('synthetic-unchanged');");
  empty.close();
  assert.throws(()=>openRollbackDatabase32(missingLedger),/no such table: schema_migrations/);
  const unchanged=new Database(missingLedger,{readonly:true});
  assert.deepEqual(unchanged.prepare("SELECT * FROM marker").all(),[{value:"synthetic-unchanged"}]);
  unchanged.close();
  const path=join(root,"business-032.sqlite");
  forward=initializeDatabase(path);
  const hash=await hashPassword("synthetic-only-password");
  const adminId=insertAuthenticationUser(forward,{email:"admin@synthetic.invalid",passwordHash:hash,status:"active",role:"admin"});
  const userId=insertAuthenticationUser(forward,{email:"buyer@synthetic.invalid",passwordHash:hash,status:"active"});
  insertAuthenticationUser(forward,{email:"new@synthetic.invalid",passwordHash:hash,status:"active"});
  await loginAndCreateSession(forward,"buyer@synthetic.invalid","synthetic-only-password",TOKEN_KEYRING,{now:()=>now});
  let sequence=0;
  const dependencies=paymentDependencies(forward,undefined,()=>`${String(++sequence).padStart(8,"0")}-2222-4222-8222-222222222222`);
  const quote=resolveQuote(forward,{selection,couponCode:null,now:()=>now});
  const input=(n)=>({idempotencyKey:`synthetic-rollback-${n}`,rawAccessToken:Buffer.alloc(32,n).toString("base64url"),
    selection,contact:"synthetic",scenarios:[],notes:null,acknowledgedAmountFen:quote.amountFen,userId});
  const paid=createPaymentOrder(dependencies,input(1));
  createPaymentOrder(dependencies,input(2));
  finalizePaid(dependencies,{outTradeNo:paid.orderRef,tradeNo:"synthetic-trade-1",tradeStatus:"TRADE_SUCCESS",
    totalAmount:(quote.amountFen/100).toFixed(2),totalAmountFen:quote.amountFen,
    appId:dependencies.appId,sellerId:dependencies.sellerId});
  const service=forward.prepare("SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?")
    .get(paid.orderRef);
  forward.prepare("UPDATE services SET status='open',ends_at='2026-12-01T00:00:00.000Z',opened_by_admin_id=?,opened_at=?,updated_at=? WHERE id=?")
    .run(adminId,now.toISOString(),now.toISOString(),service.id);
  forward.prepare(`INSERT INTO service_entitlements (service_id,user_id,plan_id,monthly_plan_id,monthly_price_fen,
    period_start,period_end,period_months,discount_numerator,discount_denominator,usage_start,usage_end,
    usage_used_gb,usage_quota_gb,provider_binding_ref,binding_provenance,created_at,updated_at)
    VALUES (?,?,?,?,?,'2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',1,1,1,
    '2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',80,200,'synthetic-binding','synthetic',?,?)`)
    .run(service.id,userId,quote.planId,quote.planId,quote.listPriceFen,now.toISOString(),now.toISOString());
  scheduleServiceDowngrade(forward,userId,service.id,"half-200g",now);
  updateCatalogDirectoryStatus(forward,{kind:"operator",typeId:"local-isp",regionId:"us",ispId:"us-verizon",
    isActive:false,adminUserId:adminId,now:()=>now});
  const snapshots={
    users:forward.prepare("SELECT id,email,last_successful_web_login_at FROM users ORDER BY id").all(),
    orders:forward.prepare("SELECT order_ref,status,amount_fen FROM orders ORDER BY id").all(),
    changes:forward.prepare("SELECT service_id,status,target_plan_id FROM service_changes ORDER BY id").all(),
    plans:forward.prepare("SELECT id,price_fen,is_active,occupied_slots FROM sellable_plans WHERE id=?").all(quote.planId),
  };
  assert.deepEqual(snapshots.orders.map((row)=>row.status),["paid","pending"]);
  assert.equal(snapshots.changes[0].status,"scheduled");
  forward.close();forward=null;

  recovered=openRollbackDatabase32(path);
  assert.equal(prepareDatabaseReadinessProbe(recovered).isReady(),true);
  assert.deepEqual(recovered.prepare("SELECT id,email,last_successful_web_login_at FROM users ORDER BY id").all(),snapshots.users);
  assert.deepEqual(recovered.prepare("SELECT order_ref,status,amount_fen FROM orders ORDER BY id").all(),snapshots.orders);
  assert.deepEqual(recovered.prepare("SELECT service_id,status,target_plan_id FROM service_changes ORDER BY id").all(),snapshots.changes);
  assert.deepEqual(recovered.prepare("SELECT id,price_fen,is_active,occupied_slots FROM sellable_plans WHERE id=?").all(quote.planId),snapshots.plans);
  assert.throws(()=>rollbackQuote(recovered,{selection,couponCode:null,now:()=>now}),
    (error)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
  assert.throws(()=>rollbackOrder(paymentDependencies(recovered),input(3)),
    (error)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
  await rollbackLogin(recovered,"new@synthetic.invalid","synthetic-only-password",TOKEN_KEYRING,{now:()=>now});
  assert.equal(recovered.prepare("SELECT last_successful_web_login_at FROM users WHERE email='new@synthetic.invalid'").get().last_successful_web_login_at,now.toISOString());

  app=buildApp({
    auth:{database:recovered,nodeEnv:"test",tokenHmacKeyring:TOKEN_KEYRING,
      rateLimitKeyring:{version:1,keys:{"1":Buffer.alloc(32,0x31).toString("base64")}},
      csrfSigningKey:CSRF_KEY,loginSessionDependencies:{now:()=>now},sessionLookupDependencies:{now:()=>now},
      rateLimitDependencies:{now:()=>now}},
    payment:{...paymentDependencies(recovered),now:()=>now},
    readiness:prepareDatabaseReadinessProbe(recovered),
  });
  await app.listen({host:"127.0.0.1",port:0});
  const address=app.server.address();
  assert.ok(address&&typeof address!=="string");
  const base=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base+"/ready")).status,200);
  const catalog=await fetch(base+"/api/catalog/plans");
  assert.equal(catalog.status,200);
  const item=(await catalog.json()).items.find((entry)=>entry.typeId===selection.typeId&&entry.regionId===selection.regionId&&entry.ispId===selection.ispId&&entry.specId===selection.specId&&entry.durationId===selection.durationId);
  assert.equal(item?.isActive,false);
  assert.equal((await fetch(base+"/api/pay/quote",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({...selection,couponCode:null})})).status,409);
  assert.equal((await fetch(base+"/api/admin/catalog-directory")).status,404);
  assert.deepEqual(recovered.prepare("SELECT order_ref,status,amount_fen FROM orders ORDER BY id").all(),snapshots.orders);
  assert.deepEqual(recovered.prepare("SELECT service_id,status,target_plan_id FROM service_changes ORDER BY id").all(),snapshots.changes);
  console.log("independent 381+patch rollback: 031/missing/033 rejection, 032 runtime, data preservation, closed sales, login recording PASS");
} finally {
  if(app) await app.close();
  if(recovered) recovered.close();
  if(forward) forward.close();
  rmSync(root,{recursive:true,force:true});
}

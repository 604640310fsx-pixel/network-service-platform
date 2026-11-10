import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";
const loader=createTsxLoader();
const {monthlyPresentation}=loader.load("app/components/subscribe/subscriptionPresentation.ts") as {
  monthlyPresentation:(index:unknown,selection:unknown)=>unknown;
};
const selection={typeId:"local-isp",regionId:"us",ispId:"us-verizon",specId:"half-200g",durationId:"month-12"};
function row(specId:string|null,priceFen:number,extra={}) {return {typeId:"local-isp",regionId:"us",ispId:"us-verizon",specId,durationId:"month-1",isActive:true,soldOut:false,priceFen,...extra};}
function index(rows:ReturnType<typeof row>[]) {return Object.fromEntries(rows.map(r=>[[r.typeId,r.regionId,r.ispId,r.specId??"",r.durationId].join("|"),r]));}
test("monthly breakdown uses live original and selected catalogue tuples, never static prices or period reconstruction",()=>{
  const rows=[row(null,7900),row("half-200g",8900),row("half-200g",79000,{durationId:"month-12"})];
  assert.deepEqual(monthlyPresentation(index(rows),selection),{monthlyFen:8900,baseMonthlyFen:7900,addonMonthlyFen:1000});
  assert.deepEqual(monthlyPresentation(index([row(null,10100),row("half-200g",11900)]),selection),{monthlyFen:11900,baseMonthlyFen:10100,addonMonthlyFen:1800});
});
test("residential breakdown reads exact server snapshot fields instead of original shared SKU labels",()=>{
  const selected=row("res-v2-optimized-300g",25100,{typeId:"residential",residentialOptions:{baseMonthlyFen:23900,addonMonthlyFen:1200}});
  assert.deepEqual(monthlyPresentation(index([selected]),{...selection,typeId:"residential",specId:selected.specId}),{monthlyFen:25100,baseMonthlyFen:23900,addonMonthlyFen:1200});
});
test("missing, sold out and inactive selected month stay pending; missing base never invents an addon",()=>{
  assert.equal(monthlyPresentation(null,selection),null);
  assert.equal(monthlyPresentation(index([row("half-200g",8900,{soldOut:true})]),selection),null);
  assert.equal(monthlyPresentation(index([row("half-200g",8900,{isActive:false})]),selection),null);
  assert.deepEqual(monthlyPresentation(index([row("half-200g",8900)]),selection),{monthlyFen:8900,baseMonthlyFen:null,addonMonthlyFen:null});
});
test("pure IP route presentation compares the same traffic tier, without negative invented addons",()=>{
  const s={...selection,typeId:"pure-native-ip",specId:"half-500g"};
  const entries=[row("ordinary-500g",2900,{typeId:s.typeId}),row("half-500g",3900,{typeId:s.typeId})];
  assert.deepEqual(monthlyPresentation(index(entries),s),{monthlyFen:3900,baseMonthlyFen:2900,addonMonthlyFen:1000});
});
test("v11 preserves shell and new-purchase-only normalization; pending reminders only read the existing owner list",()=>{
  const source=(p:string)=>readFileSync(new URL(p,import.meta.url),"utf8");
  const page=source("../app/components/subscribe/SubscribePage.tsx");
  const notice=source("../app/components/subscribe/PendingOrderNotice.tsx");
  assert.match(page,/entry\.selection\.typeId === "residential" &&/);
  assert.match(page,/needsResidentialReconfirm = selection\.typeId === "residential" &&/);
  assert.match(notice,/getMyOrders\(controller\.signal\)/);
  assert.doesNotMatch(notice,/getOrderStatus|fetch\(|method:.*POST|simulate|localStorage/);
  assert.match(page,/sub-configurator-v11/);
  const copy=source("../app/i18n/zh.ts");
  assert.ok(copy.includes("独享干净•流媒体全解锁、ChatGPT Plus用户"));
  assert.match(page, /className="sub-type-spec-label">\{product\.tag\}/);
  assert.doesNotMatch(page, /className="sub-product-tag"/);
});

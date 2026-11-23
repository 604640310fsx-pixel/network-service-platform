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
  assert.ok(copy.includes('"pure-native-ip": { tag: "200G–1T流量", bandwidth: "带宽100Mbps", audience: ""'));
  assert.match(page, /className="sub-type-spec-label">\{product\.tag\}/);
  assert.doesNotMatch(page, /className="sub-product-tag"/);
});
test("product card specs use a muted dot separator and a compact three-row mobile layout without a split divider",()=>{
  const css=readFileSync(new URL("../app/components/subscribe/subscribe-configurator.css",import.meta.url),"utf8");
  assert.match(css,/\.sub-type-spec-label::after \{ content: "·"; margin-left: 6px; color: var\(--cc-text-3\); \}/);
  assert.match(css,/\.sub-type-specs \{ display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 6px;/);
  const mobile=css.slice(css.indexOf("@media (max-width: 600px)"));
  assert.match(mobile,/\.sub-type-price \{ grid-column: 2; grid-row: 1; align-self: center;[^}]*padding: 0 28px 0 0; border-top: 0; white-space: nowrap; \}/);
  assert.match(mobile,/\.sub-solution-footer \{ grid-column: 1 \/ -1; grid-row: 3;[^}]*padding-top: 0; border-top: 0; \}/);
  assert.match(mobile,/\.sub-type-option::after \{ content: ""; position: absolute;[^}]*border: 1\.5px solid var\(--cc-text-3\);/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

const loader = createTsxLoader();
const { subscriptionLineDisplay } = loader.load("app/components/subscribe/lineDisplay.ts") as {
  subscriptionLineDisplay: (text: string, lang: "zh" | "en", catalogText: (text: string) => string) => string;
};
const { residentialLines, LOCAL_ISP_BASE_LINE_ID } = loader.load("app/lib/subscribeCatalog.ts") as {
  residentialLines: { id: string; name: string }[];
  LOCAL_ISP_BASE_LINE_ID: string;
};
const { resolveSelection, selectionToQuery } = loader.load("app/lib/resolveSelection.ts") as {
  resolveSelection: (selection: Record<string, string | null>, availability?: Record<string, unknown>) => {
    selectedLine: { id: string; name: string } | null;
    summary: { spec: string; total: number | null };
  };
  selectionToQuery: (selection: Record<string, string | null>) => string;
};
const { planAvailabilityKey } = loader.load("app/lib/planAvailability.ts") as {
  planAvailabilityKey: (typeId: string, regionId: string, ispId: string, specId: string | null, durationId: string) => string;
};
const identity = (text: string) => text;
const display = (text: string, lang: "zh" | "en" = "zh") => subscriptionLineDisplay(text, lang, identity);

test("direct and optimized catalogue names display consistently without repeated suffixes", () => {
  for (const raw of ["普通线路", "默认线路", "普通路线", "默认路线", "默认直连", "默认直连（高峰期不稳定）"]) {
    assert.equal(display(raw), "直连无优化（稳定性差）", raw);
    assert.equal(display(`${raw} · 200G`), "直连无优化（稳定性差） · 200G", raw);
  }
  for (const raw of ["半优化线路", "优化线路"]) {
    assert.equal(display(raw), "优化线路（高峰期稍慢）", raw);
    assert.equal(display(`${raw} · 1T`), "优化线路（高峰期稍慢） · 1T", raw);
  }
  assert.equal(display("直连无优化（稳定性差） · 300G"), "直连无优化（稳定性差） · 300G");
  assert.equal(display("优化线路（高峰期稍慢）"), "优化线路（高峰期稍慢）");
  assert.equal(display("Default direct (unstable at peak times)", "en"), "Direct, unoptimized (poor stability)");
  assert.equal(display("Partially optimized route · 500G", "en"), "Optimized route (slower at peak times) · 500G");
  assert.equal(display("Direct, unoptimized (poor stability)", "en"), "Direct, unoptimized (poor stability)");
});

test("other tiers and ordinary narrative remain unchanged", () => {
  for (const text of ["高速线路", "直播专线", "三网专线", "普通线路拥堵时可能变慢", "请选择默认线路", "优化线路的价格", "高速线路 · 1T"]) {
    assert.equal(display(text), text);
  }
  assert.equal(subscriptionLineDisplay("其他名称", "en", (text) => `translated:${text}`), "translated:其他名称");
});

test("selected line and summary use display copy while catalogue IDs, prices and query payload stay raw", () => {
  const selection = { typeId: "residential", regionId: "vn", ispId: "vnpt-corp", specId: "res-v2-direct-200g", durationId: "month-1" };
  const priceFen = 12345; // Synthetic test price, not a quotation.
  const availability = { [planAvailabilityKey("residential", "vn", "vnpt-corp", "res-v2-direct-200g", "month-1")]: {
    ...selection, priceFen, isActive: true, soldOut: false,
  } };
  const resolved = resolveSelection(selection, availability);
  assert.equal(resolved.selectedLine?.id, "direct");
  assert.equal(display(resolved.selectedLine!.name), "直连无优化（稳定性差）");
  assert.equal(display(resolved.summary.spec), "直连无优化（稳定性差） · 200G");
  assert.equal(residentialLines[0]?.name, "默认直连（高峰期不稳定）");
  assert.equal(residentialLines[1]?.id, "optimized");
  assert.equal(LOCAL_ISP_BASE_LINE_ID, "ordinary");
  assert.equal(resolved.summary.total, priceFen / 100);
  assert.match(selectionToQuery(selection), /spec=res-v2-direct-200g/);
  assert.equal(availability[planAvailabilityKey("residential", "vn", "vnpt-corp", "res-v2-direct-200g", "month-1")]?.priceFen, priceFen);
  const optimized = resolveSelection({ ...selection, specId: "res-v2-optimized-200g" });
  assert.equal(optimized.selectedLine?.id, "optimized");
  assert.equal(display(optimized.summary.spec), "优化线路（高峰期稍慢） · 200G");
  const local = resolveSelection({ typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: null, durationId: "month-1" });
  assert.equal(local.selectedLine?.id, "ordinary");
  assert.equal(display(local.summary.spec), "直连无优化（稳定性差） · 200G");
});

test("existing admin pending-open reminder presents the new spec as a readable line and traffic tier", () => {
  const source = readFileSync(new URL("../app/components/dashboard/AdminPendingServices.tsx", import.meta.url), "utf8");
  assert.match(source, /getAdminPendingServices\(controller\.signal\)/);
  assert.match(source, /待开通服务/);
  assert.match(source, /item\.typeId === "us-local-carrier"[\s\S]*?subscriptionLineDisplay\(summary\.spec, "zh"/);
  for (const fact of ["summary.type", "summary.region", "summary.isp", "specLabel", "summary.duration"]) {
    assert.ok(source.includes(`<dd>{${fact}}</dd>`), fact);
  }
  for (const [specId, label] of [["direct-200g", "直连无优化（稳定性差） · 200G"],
    ["optimized-500g", "优化线路（高峰期稍慢） · 500G"]] as const) {
    const selection = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId, durationId: "month-1" };
    const summary = resolveSelection(selection).summary;
    assert.equal(summary.type, "独享双ISP静态原生");
    assert.equal(summary.region, "美国");
    assert.equal(summary.isp, "NTT");
    assert.equal(display(summary.spec), label);
    assert.equal(summary.duration, "月付");
  }
});

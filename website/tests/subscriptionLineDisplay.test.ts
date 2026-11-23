import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

const loader = createTsxLoader();
const { subscriptionLineDisplay, subscriptionLineSubtitle, isRecommendedLine } = loader.load("app/components/subscribe/lineDisplay.ts") as {
  subscriptionLineDisplay: (text: string, lang: "zh" | "en", catalogText: (text: string) => string) => string;
  subscriptionLineSubtitle: (lineIdOrName: string, lang: "zh" | "en") => string | null;
  isRecommendedLine: (lineId: string, availableLineIds?: readonly string[]) => boolean;
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
    assert.equal(display(raw), "默认直连", raw);
    assert.equal(display(`${raw} · 200G`), "默认直连 · 200G", raw);
  }
  for (const raw of ["半优化线路", "优化线路"]) {
    assert.equal(display(raw), "优化线路", raw);
    assert.equal(display(`${raw} · 1T`), "优化线路 · 1T", raw);
  }
  assert.equal(display("默认直连 · 300G"), "默认直连 · 300G");
  assert.equal(display("优化线路"), "优化线路");
  assert.equal(display("Default direct (unstable at peak times)", "en"), "Default direct");
  assert.equal(display("Partially optimized route · 500G", "en"), "Optimized route · 500G");
  assert.equal(display("Default direct", "en"), "Default direct");
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
  assert.equal(display(resolved.selectedLine!.name), "默认直连");
  assert.equal(display(resolved.summary.spec), "默认直连 · 200G");
  assert.equal(residentialLines[0]?.name, "默认直连（高峰期不稳定）");
  assert.equal(residentialLines[1]?.id, "optimized");
  assert.equal(LOCAL_ISP_BASE_LINE_ID, "ordinary");
  assert.equal(resolved.summary.total, priceFen / 100);
  assert.match(selectionToQuery(selection), /spec=res-v2-direct-200g/);
  assert.equal(availability[planAvailabilityKey("residential", "vn", "vnpt-corp", "res-v2-direct-200g", "month-1")]?.priceFen, priceFen);
  const optimized = resolveSelection({ ...selection, specId: "res-v2-optimized-200g" });
  assert.equal(optimized.selectedLine?.id, "optimized");
  assert.equal(display(optimized.summary.spec), "优化线路 · 200G");
  const local = resolveSelection({ typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: null, durationId: "month-1" });
  assert.equal(local.selectedLine?.id, "ordinary");
  assert.equal(display(local.summary.spec), "默认直连 · 200G");
});

test("existing admin pending-open reminder presents the new spec as a readable line and traffic tier", () => {
  const source = readFileSync(new URL("../app/components/dashboard/AdminPendingServices.tsx", import.meta.url), "utf8");
  assert.match(source, /getAdminPendingServices\(controller\.signal\)/);
  assert.match(source, /待开通服务/);
  assert.match(source, /item\.typeId === "us-local-carrier"[\s\S]*?subscriptionLineDisplay\(summary\.spec, "zh"/);
  for (const fact of ["summary.type", "summary.region", "summary.isp", "specLabel", "summary.duration"]) {
    assert.ok(source.includes(`<dd>{${fact}}</dd>`), fact);
  }
  for (const [specId, label] of [["direct-200g", "默认直连 · 200G"],
    ["optimized-500g", "优化线路 · 500G"]] as const) {
    const selection = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId, durationId: "month-1" };
    const summary = resolveSelection(selection).summary;
    assert.equal(summary.type, "原生双ISP");
    assert.equal(summary.region, "美国");
    assert.equal(summary.isp, "NTT");
    assert.equal(display(summary.spec), label);
    assert.equal(summary.duration, "月付");
  }
});

test("summary labels are clean four-character tier names in zh", () => {
  const raws = ["普通线路", "默认直连（高峰期不稳定）", "半优化线路", "优化线路", "高速线路", "三网专线", "直播专线"];
  for (const raw of raws) {
    const label = display(raw);
    assert.equal([...label].length, 4, `${raw} -> ${label}`);
    assert.doesNotMatch(label, /[（(]/, raw);
  }
  assert.equal(display("Direct, unoptimized (poor stability)", "en"), "Default direct");
  assert.equal(display("Optimized route (slower at peak times) · 1T", "en"), "Optimized route · 1T");
});

test("every route tier has an exact six-character muted subtitle", () => {
  const expected: [string[], string, string][] = [
    [["direct", "ordinary", "默认直连（高峰期不稳定）", "普通路线"], "晚高峰易卡顿", "Prone to peak lag"],
    [["half", "optimized", "半优化线路", "优化线路"], "日常轻度使用", "Light daily use"],
    [["high", "highspeed", "高速线路"], "全天流畅推荐", "Smooth all day"],
    [["three-net", "live", "三网专线", "直播专线"], "低延迟高稳定", "Low latency & steady"],
  ];
  for (const [keys, zh, en] of expected) {
    assert.equal([...zh].length, 6, zh);
    for (const key of keys) {
      assert.equal(subscriptionLineSubtitle(key, "zh"), zh, key);
      assert.equal(subscriptionLineSubtitle(key, "en"), en, key);
    }
  }
  assert.equal(subscriptionLineSubtitle("unknown-line", "zh"), null);
});

test("route cards render the subtitle and the 选择线路 helper note", () => {
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  assert.match(page, /<h3>\{copy\.specSection\.lineTitle\}<\/h3><p className="sub-line-hint" id="sub-line-hint">\{copy\.specSection\.lineHint\}<\/p>/);
  assert.match(page, /aria-describedby="sub-line-hint"/);
  assert.match(page, /subscriptionLineSubtitle\(line\.id, lang\)/);
  assert.match(page, /<small className="sub-line-subtitle">\{subtitle\}<\/small>/);
  assert.match(page, /line\.notice && <small>\{ct\(line\.notice\)\}<\/small>/);
  const zh = readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8");
  const en = readFileSync(new URL("../app/i18n/en.ts", import.meta.url), "utf8");
  assert.ok(zh.includes('lineHint: "决定国内连接速度与晚高峰表现；自备中转前置选「默认直连」即可"'));
  assert.ok(en.includes('lineHint: "Sets direct connection speed and peak-hour performance; choose Default direct if using your own relay"'));
  const css = readFileSync(new URL("../app/components/subscribe/subscribe-configurator.css", import.meta.url), "utf8");
  // Muted but AA-contrast (text-2) secondary copy.
  assert.match(css, /\.sub-line-subtitle \{ color: var\(--cc-text-2\)/);
  assert.match(css, /\.sub-line-hint \{[^}]*color: var\(--cc-text-2\)/);
});

test("only the high-speed route card carries the 推荐 badge", () => {
  for (const id of ["high", "highspeed"]) assert.equal(isRecommendedLine(id), true, id);
  for (const id of ["direct", "ordinary", "half", "optimized", "three-net", "live", "unknown"]) assert.equal(isRecommendedLine(id), false, id);
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  assert.match(page, /\{recommended && <i className="sub-tag is-accent sub-line-badge">\{copy\.specSection\.lineRecommended\}<\/i>\}/);
  const zh = readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8");
  const en = readFileSync(new URL("../app/i18n/en.ts", import.meta.url), "utf8");
  assert.ok(zh.includes('lineRecommended: "推荐"'));
  assert.ok(en.includes('lineRecommended: "Recommended"'));
});

test("route and traffic cards announce their prices and the badge is a corner tag", () => {
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  // aria-label replaces card content for screen readers, so it must carry the visible price facts.
  assert.match(page, /const cardLabel = \[lineText\(line\.name\), recommended \? copy\.specSection\.lineRecommended : null, subtitle, lineAddonText\]/);
  assert.match(page, /const trafficLabel = \[traffic\.name, devicesText, monthlyText, includedText, trafficAddonText\]/);
  assert.match(page, /label=\{trafficLabel\}/);
  assert.match(page, /className=\{`sub-package-option\$\{recommended \? " is-recommended" : ""\}`\}/);
  const css = readFileSync(new URL("../app/components/subscribe/subscribe-configurator.css", import.meta.url), "utf8");
  assert.match(css, /\.sub-line-badge \{ position: absolute; top: -1px; right: -1px; z-index: 1; padding: 1px 8px; border: 0; border-radius: 0 10px 0 9px; background: #f59e0b; color: #1d1b17;/);
  assert.match(css, /\.sub-package-lines \.sub-package-option::after \{[^}]*border: 1\.5px solid var\(--cc-text-3\)/);
  assert.match(css, /\.cc-shell\[data-theme="light"\] \.sub-configurator-v11 \.sub-package-option :is\(\.sub-addon, \.sub-traffic-monthly-price:not\(\.is-pending\)\) \{ color: #945a00; \}/);
});

test("optimized route is recommended only when the package has no high-speed route", () => {
  // 独享双ISP静态原生 (us-local-carrier) offers direct + optimized only.
  assert.equal(isRecommendedLine("optimized", ["direct", "optimized"]), true);
  assert.equal(isRecommendedLine("direct", ["direct", "optimized"]), false);
  // Packages with a high-speed route keep recommending it, not the optimized one.
  assert.equal(isRecommendedLine("optimized", ["direct", "optimized", "highspeed", "live"]), false);
  assert.equal(isRecommendedLine("half", ["ordinary", "half", "high", "three-net"]), false);
  assert.equal(isRecommendedLine("highspeed", ["direct", "optimized", "highspeed", "live"]), true);
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  assert.match(page, /isRecommendedLine\(line\.id, selection\.availableLines\.map\(\(option\) => option\.id\)\)/);
});

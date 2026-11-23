import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";
import { createTsxLoader } from "./support/tsxModules.ts";

type Selection = { typeId: string | null; regionId: string | null; ispId: string | null; specId: string | null; durationId: string | null };

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const loader = createTsxLoader();
const { homeRegionHref } = loader.load("app/components/home/homeRegionLinks.ts") as { homeRegionHref: (id: string) => string };
const { parseSelectionParams, resolveNewPurchaseSelection, withPackageDefaults } = loader.load("app/lib/resolveSelection.ts") as {
  parseSelectionParams: (params: URLSearchParams) => Selection;
  resolveNewPurchaseSelection: (selection: Selection) => { summary: { complete: boolean } };
  withPackageDefaults: (selection: Selection) => Selection;
};

test("product cards carry only traffic, bandwidth and short selling points (no audience line)", () => {
  const expected = {
    "pure-native-ip": { zh: { tag: "200G–1T流量", bandwidth: "带宽100Mbps", sellingPoints: ["一人一IP", "美区原生可选"] }, en: { tag: "200G–1T data", bandwidth: "100Mbps", sellingPoints: ["Dedicated 1-to-1 IP", "US native optional"] } },
    "us-local-carrier": { zh: { tag: "200G / 500G流量", bandwidth: "带宽200Mbps", sellingPoints: ["NTT", "GTT", "Cogent"] }, en: { tag: "200G / 500G data", bandwidth: "200Mbps", sellingPoints: ["NTT", "GTT", "Cogent"] } },
    "local-isp": { zh: { tag: "200G–1T流量", bandwidth: "带宽100Mbps", sellingPoints: ["AT&T", "Verizon", "Cox"] }, en: { tag: "200G–1T data", bandwidth: "100Mbps", sellingPoints: ["AT&T", "Verizon", "Cox"] } },
    residential: { zh: { tag: "200G–1T流量", bandwidth: "带宽100Mbps", sellingPoints: ["当地拉线真家宽", "长期稳定选择"] }, en: { tag: "200G–1T data", bandwidth: "100Mbps", sellingPoints: ["Locally installed broadband", "Long-term stability"] } },
  } as const;
  for (const [id, byLang] of Object.entries(expected)) {
    for (const [lang, dict] of [["zh", zh], ["en", en]] as const) {
      const card = dict.subscribe.productCards[id]!;
      assert.equal(card.audience, "", `${lang} ${id} audience`);
      assert.deepEqual({ tag: card.tag, bandwidth: card.bandwidth, sellingPoints: card.sellingPoints }, byLang[lang], `${lang} ${id}`);
    }
  }
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  assert.match(page, /const productCardOrder = \["pure-native-ip", "us-local-carrier", "local-isp", "residential"\];/);
  assert.match(page, /\{product\.audience && <span className="sub-product-audience">/);
});

test("residential details show the device disclaimer to admins only", () => {
  assert.equal(zh.subscribe.residentialDevices(3), "3台设备");
  assert.equal(en.subscribe.residentialDevices(3), "3 devices");
  assert.equal(zh.subscribe.residentialDevices(null), "设备额度未指定（沿用原套餐资料）");
  assert.equal(en.subscribe.residentialDevices(null), "Device allowance unspecified (retain existing plan records)");
  const details = source("../app/components/subscribe/ResidentialOptionDetails.tsx");
  assert.match(details, /adminNote = false/);
  assert.match(details, /\{adminNote && <small>\{copy\.manual\}<\/small>\}/);
  assert.match(zh.residentialOptions.manual, /管理员人工配置/);
  assert.match(en.residentialOptions.manual, /administrator-configured/);
  for (const admin of ["AdminPendingServices", "AdminUserServicesPanel"]) {
    assert.match(source(`../app/components/dashboard/${admin}.tsx`), /<ResidentialOptionDetails options=\{[a-z]+\.residentialOptions\} adminNote \/>/, admin);
  }
  for (const buyer of ["subscribe/RequirementForm", "subscribe/OrderStatusPanel", "customer/CustomerServicesPage"]) {
    const usage = source(`../app/components/${buyer}.tsx`).match(/<ResidentialOptionDetails [^>]*\/>/)?.[0] ?? "";
    assert.ok(usage, buyer);
    assert.doesNotMatch(usage, /adminNote/, buyer);
  }
});

test("home region cards link to a complete, priced residential plan; more goes to local ISP", () => {
  const expected: Record<string, string> = {
    sg: "/subscribe?type=residential&region=sg&isp=sptel",
    jp: "/subscribe?type=residential&region=jp&isp=glbb-japan",
    vn: "/subscribe?type=residential&region=vn&isp=vnpt-corp",
    my: "/subscribe?type=residential&region=my&isp=tm-technology",
    kr: "/subscribe?type=residential&region=kr&isp=sk-broadband",
    tw: "/subscribe?type=residential&region=tw&isp=hinet",
    us: "/subscribe?type=residential&region=us&isp=cox",
    more: "/subscribe?type=local-isp&region=gb&isp=gb-bt",
  };
  for (const [regionId, href] of Object.entries(expected)) {
    assert.equal(homeRegionHref(regionId), href);
    // 与 seedSelection 同路径：URL 前缀 + withPackageDefaults 即为完整方案（价格由 /api/catalog/plans 带出）。
    const parsed = parseSelectionParams(new URL(href, "https://example.test").searchParams);
    const resolved = resolveNewPurchaseSelection(withPackageDefaults(parsed));
    assert.equal(resolved.summary.complete, true, regionId);
  }
  assert.equal(homeRegionHref("unknown"), "/subscribe");
});

test("home region cards render as router links with card-preserving link and focus styles", () => {
  const page = source("../app/components/home/HomePage.tsx");
  assert.match(page, /<Link\s+to=\{homeRegionHref\(region\.id\)\}\s+className=\{`home-region/);
  assert.doesNotMatch(page, /<div className=\{`home-region\$/);
  const css = source("../app/components/home/home.css");
  assert.match(css, /\.home-region \{[^}]*color: inherit; text-decoration: none;/);
  assert.match(css, /\.home-region:focus-visible \{ outline: 2px solid/);
});

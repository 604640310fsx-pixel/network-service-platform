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

test("English card copy uses the polished audience wording", () => {
  const cards = en.subscribe.productCards;
  assert.match(cards["local-isp"].audience, /stable Gemini region routing/);
  assert.doesNotMatch(cards["local-isp"].audience, /keeping Gemini out of China routing/);
  assert.match(cards["pure-native-ip"].audience, /shared-proxy/);
  assert.doesNotMatch(cards["pure-native-ip"].audience, /airport/);
});

test("buyer residential details drop the admin-only device disclaimer", () => {
  assert.equal(zh.subscribe.residentialDevices(3), "3台设备");
  assert.equal(en.subscribe.residentialDevices(3), "3 devices");
  assert.equal(zh.subscribe.residentialDevices(null), "设备额度未指定（沿用原套餐资料）");
  assert.equal(en.subscribe.residentialDevices(null), "Device allowance unspecified (retain existing plan records)");
  const details = source("../app/components/subscribe/ResidentialOptionDetails.tsx");
  assert.doesNotMatch(details, /copy\.manual/);
  assert.doesNotMatch(details, /<small>/);
  assert.equal("manual" in zh.residentialOptions, false);
  assert.equal("manual" in en.residentialOptions, false);
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

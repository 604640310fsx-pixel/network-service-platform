import assert from "node:assert/strict";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

/* Pure native IP traffic cards show each tier's own exact monthly price, not a "+¥0/月" add-on
   against the same tier. Prices below are synthetic availability rows, not catalogue values. */
const baseLoader = createTsxLoader();
const availability = baseLoader.load("app/lib/planAvailability.ts") as {
  planAvailabilityKey: (typeId: string, regionId: string, ispId: string, specId: string | null, durationId: string) => string;
};
const { defaultCatalogSelection } = baseLoader.load("app/lib/subscribeCatalog.ts") as { defaultCatalogSelection: Record<string, string> };

type Row = { typeId: string; regionId: string; ispId: string; specId: string; durationId: string; priceFen: number; isActive: boolean; soldOut: boolean };
const row = (specId: string, priceFen: number, extra: Partial<Row> = {}): Row =>
  ({ typeId: "pure-native-ip", regionId: "us", ispId: "native-ip", specId, durationId: "month-1", priceFen, isActive: true, soldOut: false, ...extra });

function render(rows: Row[], query: string, language: "zh" | "en" = "zh") {
  const index = Object.fromEntries(rows.map((r) => [availability.planAvailabilityKey(r.typeId, r.regionId, r.ispId, r.specId, r.durationId), r]));
  const loader = createTsxLoader({
    "app/lib/planAvailability.ts": { ...availability, usePlanAvailability: () => ({ index, loading: false, error: false }) },
    "app/components/customer/CustomerCenterShell.tsx": { useCustomerDrawer: () => ({ activeDrawer: null, openDrawer() {}, closeDrawer() {} }) },
    "app/components/subscribe/PendingOrderNotice.tsx": { PendingOrderNotice: () => null },
  });
  const React = loader.requirePackage("react") as typeof import("react");
  const { renderToStaticMarkup } = loader.requirePackage("react-dom/server") as typeof import("react-dom/server");
  const { MemoryRouter } = loader.requirePackage("react-router-dom") as typeof import("react-router-dom");
  const { I18nProvider } = loader.load("app/lib/i18n.tsx");
  const { SubscribePage } = loader.load("app/components/subscribe/SubscribePage.tsx");
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [`/subscribe?${query}`] },
    React.createElement(I18nProvider as never, { initial: language } as never, React.createElement(SubscribePage as never))));
}
function trafficCards(html: string) {
  const group = html.slice(html.indexOf('class="sub-grid sub-package-traffic'), html.indexOf('id="sub-section-duration"'));
  return [...group.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
}

const rows = [row("ordinary-200g", 1900), row("ordinary-500g", 2900), row("ordinary-1t", 3900), row("half-500g", 3900)];

test("pure native IP 200G / 500G / 1T cards show exact monthly prices instead of +¥0/月", () => {
  const html = render(rows, "type=pure-native-ip&region=us&isp=native-ip&spec=ordinary-500g&duration=month-1");
  const cards = trafficCards(html);
  assert.equal(cards.length, 3);
  for (const [card, tier, price] of [[cards[0], "200G", "¥19/月"], [cards[1], "500G", "¥29/月"], [cards[2], "1T", "¥39/月"]] as const) {
    assert.match(card!, new RegExp(`<strong>${tier}</strong>`));
    assert.match(card!, new RegExp(`sub-traffic-monthly-price">${price}<`));
    assert.doesNotMatch(card!, /\+¥0/);
  }
  const en = trafficCards(render(rows, "type=pure-native-ip&region=us&isp=native-ip&spec=ordinary-200g&duration=month-1", "en"));
  assert.match(en[2]!, /¥39\/mo/);
});

test("a pure native IP tier without a live month-1 row stays pending, never ¥0", () => {
  const html = render([row("ordinary-200g", 1900), row("ordinary-1t", 3900, { soldOut: true })], "type=pure-native-ip&region=us&isp=native-ip&spec=ordinary-200g&duration=month-1");
  const cards = trafficCards(html);
  assert.match(cards[0]!, /¥19\/月/);
  assert.match(cards[1]!, /is-pending">价格待确认</);
  assert.match(cards[2]!, /is-pending">价格待确认</);
});

test("pure native IP region dropdown names native vs broadcast IP; default selection is dual-ISP US NTT", () => {
  const html = render(rows, "type=pure-native-ip&region=tw&isp=broadcast-ip&spec=ordinary-200g&duration=month-1");
  assert.ok(html.includes("台湾（广播IP）"));
  assert.deepEqual({ ...defaultCatalogSelection }, { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: "direct-200g", durationId: "month-1" });
});

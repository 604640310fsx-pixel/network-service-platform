import assert from "node:assert/strict";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

const baseLoader = createTsxLoader();
const availability = baseLoader.load("app/lib/planAvailability.ts");
const { monthlyPresentation } = baseLoader.load("app/components/subscribe/subscriptionPresentation.ts") as {
  monthlyPresentation: (index: unknown, selection: unknown) => { monthlyFen: number; baseMonthlyFen: number; addonMonthlyFen: number } | null;
};
const { resolveSelection } = baseLoader.load("app/lib/resolveSelection.ts") as {
  resolveSelection: (selection: unknown, index: unknown) => { summary: { total: number; availability: string } };
};
const tiers = ["200g", "300g", "1t"];
const matrix = {
  sg: { isp: "sptel", direct: [159, 239, 659], optimized: [169, 251, 689], highspeed: [179, 264, 729], live: [189, 274, 759] },
  jp: { isp: "glbb-japan", direct: [149, 219, 599], optimized: [159, 231, 629], highspeed: [169, 244, 669], live: [179, 254, 699] },
};
function row(regionId: string, ispId: string, line: string, tier: string, priceFen: number, baseMonthlyFen: number, addonMonthlyFen: number, extra = {}) {
  return { typeId: "residential", regionId, ispId, specId: `res-v2-${line}-${tier}`, durationId: "month-1", priceFen, isActive: true, soldOut: false,
    residentialOptions: { baseMonthlyFen, addonMonthlyFen }, ...extra };
}
type Row = ReturnType<typeof row>;
const monthlyRows = Object.entries(matrix).flatMap(([regionId, values]) =>
  (["direct", "optimized", "highspeed", "live"] as const).flatMap(line => tiers.map((tier, i) =>
    row(regionId, values.isp, line, tier, values[line][i]! * 100, values.direct[i]! * 100, (values[line][i]! - values.direct[i]!) * 100))));
const selection = { typeId: "residential", regionId: "sg", ispId: "sptel", specId: "res-v2-direct-200g", durationId: "month-12" };
const indexOf = (rows: Row[]) => Object.fromEntries(rows.map(r => [[r.typeId, r.regionId, r.ispId, r.specId, r.durationId].join("|"), r]));

function renderPage(rows: Row[], selected = selection, language: "zh" | "en" = "zh") {
  const index = indexOf(rows);
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
  const url = `/subscribe?type=${selected.typeId}&region=${selected.regionId}&isp=${selected.ispId}&spec=${selected.specId}&duration=${selected.durationId}`;
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [url] },
    React.createElement(I18nProvider as never, { initial: language } as never, React.createElement(SubscribePage as never))));
}
function trafficCards(html: string) {
  const group = html.slice(html.indexOf('class="sub-grid sub-package-traffic'), html.indexOf('id="sub-section-duration"'));
  return [...group.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
}

test("each region/ISP/line/tier reads its own full month-1 offer, independent of selected period and cheaper tuples", () => {
  const index = indexOf([...monthlyRows,
    row("sg", "other-isp", "direct", "200g", 100, 100, 0),
    row("sg", "sptel", "direct", "200g", 152600, 15900, 0, { durationId: "month-12" })]);
  for (const r of monthlyRows) {
    const result = monthlyPresentation(index, { ...r, durationId: "month-12" });
    assert.equal(result?.monthlyFen, r.priceFen);
    assert.equal(result?.baseMonthlyFen, r.residentialOptions.baseMonthlyFen);
    assert.equal(result?.addonMonthlyFen, r.residentialOptions.addonMonthlyFen);
  }
  assert.equal(monthlyPresentation(index, { ...selection, ispId: "missing-isp" }), null);
  const unusual = row("sg", "sptel", "direct", "200g", 17123, 15900, 1000);
  assert.equal(monthlyPresentation(indexOf([unusual]), selection)?.monthlyFen, 17123, "use row.priceFen without reconstructing or adding the addon again");
});

test("real SubscribePage renders all three full monthly prices, devices and secondary included fees for all four lines", () => {
  for (const line of ["direct", "optimized", "highspeed", "live"] as const) {
    const cards = trafficCards(renderPage(monthlyRows, { ...selection, specId: `res-v2-${line}-300g`, durationId: "month-1" }));
    assert.equal(cards.length, 3);
    cards.forEach((card, i) => {
      assert.ok(card.includes(`月付 ¥${matrix.sg[line][i]}/月`));
      assert.ok(card.includes(`设备限制：${[3, 5, 10][i]}台`));
      assert.doesNotMatch(card, /\+¥0|disabled=/);
      const addon = matrix.sg[line][i]! - matrix.sg.direct[i]!;
      if (addon) assert.ok(card.includes(`已含线路费 ¥${addon}/月`));
      else assert.doesNotMatch(card, /已含线路费/);
    });
  }
  const jp = trafficCards(renderPage(monthlyRows, { ...selection, regionId: "jp", ispId: "glbb-japan", specId: "res-v2-optimized-1t" }));
  [159, 231, 629].forEach((price, i) => assert.ok(jp[i]!.includes(`月付 ¥${price}/月`)));
});

for (const mode of ["missing", "inactive", "sold-out"] as const) {
  test(`${mode} monthly offer stays pending without disabling a tier with an available annual offer`, () => {
    const annual = row("sg", "sptel", "direct", "200g", 152600, 15900, 0, { durationId: "month-12" });
    const monthly = row("sg", "sptel", "direct", "200g", 15900, 15900, 0,
      mode === "inactive" ? { isActive: false } : { soldOut: true });
    const rows = [...monthlyRows.filter(r => !(r.regionId === "sg" && r.specId === selection.specId)), annual,
      ...(mode === "missing" ? [] : [monthly])];
    const index = indexOf(rows);
    const before = resolveSelection(selection, index).summary;
    assert.equal(monthlyPresentation(index, selection), null);
    const html = renderPage(rows);
    const cards = trafficCards(html);
    assert.equal(cards.length, 3);
    assert.match(cards[0]!, /月付价格待确认/);
    assert.doesNotMatch(cards[0]!, /disabled=|¥0|月付 ¥159/);
    assert.equal(before.total, 1526);
    assert.equal(before.availability, "available");
    assert.match(html, /<button type="button">立即下单<\/button>/);
    assert.deepEqual(resolveSelection(selection, index).summary, before);
  });
}

test("quarter/annual summaries keep their exact catalogue totals and card amounts stay monthly", () => {
  for (const [durationId, priceFen] of [["month-3", 42900], ["month-12", 152600]] as const) {
    const rows = [...monthlyRows, row("sg", "sptel", "direct", "200g", priceFen, 15900, 0, { durationId })];
    const selected = { ...selection, durationId };
    const before = resolveSelection(selected, indexOf(rows)).summary;
    const html = renderPage(rows, selected);
    assert.equal(before.total, priceFen / 100);
    assert.ok(html.includes(`<b>¥${priceFen / 100}</b>`));
    const cards = trafficCards(html);
    [159, 239, 659].forEach((price, i) => assert.ok(cards[i]!.includes(`月付 ¥${price}/月`)));
    assert.deepEqual(resolveSelection(selected, indexOf(rows)).summary, before);
  }
});

test("English monthly basis and included-fee copy use the same exact live amounts", () => {
  const cards = trafficCards(renderPage(monthlyRows, { ...selection, specId: "res-v2-optimized-200g" }, "en"));
  [169, 251, 689].forEach((price, i) => assert.ok(cards[i]!.includes(`Monthly ¥${price}/mo`)));
  assert.match(cards[1]!, /Includes route fee ¥12\/mo/);
});

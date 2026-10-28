import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatCardYuan,
  regionFromPriceFen,
  specMonthlyPriceFen,
  typeFromPriceFen,
} from "../app/lib/cardPrices.ts";

type Item = {
  typeId: string;
  regionId: string;
  ispId: string;
  specId: string | null;
  durationId: string;
  priceFen: number;
  isActive: boolean;
  soldOut: boolean;
};

function item(overrides: Partial<Item>): Item {
  return {
    typeId: "residential",
    regionId: "us",
    ispId: "att",
    specId: "shared",
    durationId: "month-1",
    priceFen: 9900,
    isActive: true,
    soldOut: false,
    ...overrides,
  };
}

function index(items: Item[]) {
  return Object.fromEntries(items.map((entry, i) => [String(i), entry]));
}

const catalog = index([
  item({ priceFen: 9900 }),
  item({ durationId: "month-3", priceFen: 26700 }),
  item({ regionId: "jp", priceFen: 7900 }),
  item({ regionId: "jp", specId: "dedicated", priceFen: 12900 }),
  item({ regionId: "sg", priceFen: 5000, soldOut: true }),
  item({ regionId: "sg", priceFen: 4000, isActive: false }),
  item({ regionId: "sg", priceFen: 8950 }),
  item({ typeId: "datacenter", regionId: "us", specId: null, priceFen: 5900 }),
]);

test("type and region cards use the lowest purchasable server price", () => {
  assert.equal(typeFromPriceFen(catalog, "residential"), 7900);
  assert.equal(typeFromPriceFen(catalog, "datacenter"), 5900);
  assert.equal(regionFromPriceFen(catalog, "residential", "us"), 9900);
  assert.equal(regionFromPriceFen(catalog, "residential", "jp"), 7900);
  // Sold-out and inactive tuples never set the "from" price.
  assert.equal(regionFromPriceFen(catalog, "residential", "sg"), 8950);
});

test("spec cards use the exact tuple's monthly price only", () => {
  assert.equal(specMonthlyPriceFen(catalog, "residential", "jp", "att", "dedicated"), 12900);
  assert.equal(specMonthlyPriceFen(catalog, "residential", "us", "att", "shared"), 9900);
  // No month-1 tuple for this spec in this region.
  assert.equal(specMonthlyPriceFen(catalog, "residential", "us", "att", "dedicated"), null);
  assert.equal(specMonthlyPriceFen(catalog, "residential", null, "att", "shared"), null);
  assert.equal(specMonthlyPriceFen(catalog, "residential", "us", null, "shared"), null);
  const onlyQuarterly = index([item({ durationId: "month-3", priceFen: 20000 })]);
  assert.equal(specMonthlyPriceFen(onlyQuarterly, "residential", "us", "att", "shared"), null);
  const soldOutMonthly = index([item({ soldOut: true })]);
  assert.equal(specMonthlyPriceFen(soldOutMonthly, "residential", "us", "att", "shared"), null);
});

test("loading, error, empty or unmatched availability stays price-pending", () => {
  assert.equal(typeFromPriceFen(null, "residential"), null);
  assert.equal(regionFromPriceFen(null, "residential", "us"), null);
  assert.equal(specMonthlyPriceFen(null, "residential", "us", "att", "shared"), null);
  assert.equal(typeFromPriceFen({}, "residential"), null);
  assert.equal(typeFromPriceFen(catalog, "unknown-type"), null);
  assert.equal(regionFromPriceFen(catalog, "datacenter", "jp"), null);
});

test("card prices format like order amounts", () => {
  assert.equal(formatCardYuan(5900), "¥59");
  assert.equal(formatCardYuan(12345), "¥123.45");
  assert.equal(formatCardYuan(8950), "¥89.50");
});

test("card prices come only from the server availability index", () => {
  const page = readFileSync(new URL("../app/components/subscribe/SubscribePage.tsx", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../app/lib/cardPrices.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /option\.(?:startingPrice|monthlyPrice)/);
  assert.doesNotMatch(helper, /from ["'][^"']*subscribeCatalog["']|\.(?:startingPrice|monthlyPrice)\b/);
  assert.match(helper, /import type \{ PlanAvailabilityIndex, PlanAvailabilityItem \} from "\.\/planAvailability";/);
  assert.match(page, /typeFromPriceFen\(availability\.index, option\.id\)/);
  assert.match(page, /regionFromPriceFen\(availability\.index, selection\.typeId, option\.id\)/);
  assert.match(page, /specMonthlyPriceFen\(availability\.index, selection\.typeId, selection\.regionId, selection\.ispId, option\.id\)/);
  // Each card still falls back to the fail-closed label.
  assert.equal(page.match(/=== null \? copy\.pricePending/g)?.length, 2);
  assert.match(page, /regionFromFen === null \? <small>\{copy\.pricePending\}<\/small>/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createTsxLoader } from "./support/tsxModules.ts";

const loader = createTsxLoader();
const catalog = loader.load("app/lib/subscribeCatalog.ts") as {
  networkTypes: { id: string; startingPrice: number }[];
  ispsByTypeAndRegion: Record<string, Record<string, { id: string; name: string }[]>>;
  packageLinesByTypeAndRegion: Record<string, Record<string, { id: string }[]>>;
  packageSpecsByTypeAndRegion: Record<string, Record<string, { id: string; monthlyPrice: number | null; pricesByDuration: Record<string, number>; surcharge: number }[]>>;
};
const { resolveSelection, resolveNewPurchaseSelection, withPackageDefaults, selectionToQuery } = loader.load("app/lib/resolveSelection.ts") as {
  resolveSelection: (selection: Selection, index?: Record<string, unknown>) => { summary: { total: number | null; complete: boolean; availability: string }; selectedLine: { id: string } | null };
  resolveNewPurchaseSelection: (selection: Selection, index?: Record<string, unknown>) => { summary: { total: number | null; complete: boolean }; availableIsps: { id: string }[] };
  withPackageDefaults: (selection: Selection) => Selection;
  selectionToQuery: (selection: Selection) => string;
};
const { resolvePriceFen, enumerateUsLocalCarrierOptionTuples } = loader.load("../auth-service/src/payment/pricing.ts") as {
  resolvePriceFen: (selection: Selection) => number | null;
  enumerateUsLocalCarrierOptionTuples: () => (Selection & { priceFen: number })[];
};
const { monthlyPresentation } = loader.load("app/components/subscribe/subscriptionPresentation.ts") as {
  monthlyPresentation: (index: Record<string, unknown>, selection: Selection) => { monthlyFen: number; baseMonthlyFen: number | null; addonMonthlyFen: number | null } | null;
};
type Selection = { typeId: string; regionId: string; ispId: string; specId: string | null; durationId: string };
const base = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", durationId: "month-1" };
const prices = { "direct-200g": 4900, "direct-500g": 5900, "optimized-200g": 5900, "optimized-500g": 7900 } as const;
const index = Object.fromEntries(Object.entries(prices).map(([specId, priceFen]) => [
  [base.typeId, base.regionId, base.ispId, specId, base.durationId].join("|"),
  { ...base, specId, priceFen, isActive: true, soldOut: false },
])); // Isolated synthetic availability. Never a live quote.

test("four exact month-only tuples are final prices for all four existing US carriers", () => {
  const rows = enumerateUsLocalCarrierOptionTuples();
  assert.equal(rows.length, 16);
  for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
    for (const [specId, priceFen] of Object.entries(prices)) {
      const selection = { ...base, ispId, specId };
      assert.equal(resolvePriceFen(selection), priceFen);
      assert.equal(rows.find((row) => row.ispId === ispId && row.specId === specId)?.priceFen, priceFen);
    }
  }
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-500g", durationId: "month-6" }), null);
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-500g", ispId: "forged" }), null);
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-1t" }), null);
});

test("catalogue has only the four requested tiers; synthetic server rows determine display price exactly once", () => {
  assert.equal(catalog.networkTypes.find((type) => type.id === base.typeId)?.startingPrice, 49);
  assert.deepEqual(catalog.packageLinesByTypeAndRegion[base.typeId]?.us?.map((line) => line.id), ["direct", "optimized"]);
  const specs = catalog.packageSpecsByTypeAndRegion[base.typeId]?.us ?? [];
  assert.deepEqual(Object.fromEntries(specs.map((spec) => [spec.id, spec.surcharge])), {
    "direct-200g": 0, "direct-500g": 0, "optimized-200g": 10, "optimized-500g": 20,
  });
  for (const spec of specs) {
    assert.equal(spec.monthlyPrice, null);
    assert.deepEqual(spec.pricesByDuration, {});
    const selection = { ...base, specId: spec.id };
    assert.equal(resolveSelection(selection, index).summary.total, prices[spec.id as keyof typeof prices] / 100);
    const presentation = monthlyPresentation(index, selection);
    assert.equal(presentation?.monthlyFen, prices[spec.id as keyof typeof prices]);
    assert.equal(presentation?.baseMonthlyFen, spec.id.endsWith("200g") ? 4900 : 5900);
    assert.equal(presentation?.addonMonthlyFen, spec.surcharge * 100);
    assert.match(selectionToQuery(selection), new RegExp(`spec=${spec.id}`));
  }
  assert.equal(resolveSelection({ ...base, specId: null }, index).summary.complete, false);
  assert.equal(resolveSelection({ ...base, specId: "direct-200g" }, {}).summary.total, null);
  assert.equal(resolveSelection({ ...base, specId: "optimized-200g", durationId: "month-6" }, index).summary.availability, "unavailable");
  assert.equal(withPackageDefaults({ ...base, specId: null }).specId, "direct-200g");
});

test("other product price rules remain unchanged", () => {
  assert.equal(resolvePriceFen({ typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: "half-200g", durationId: "month-1" }), 8900);
  assert.equal(resolvePriceFen({ typeId: "pure-native-ip", regionId: "us", ispId: "native-ip", specId: "ordinary-200g", durationId: "month-1" }), 1900);
  assert.equal(resolvePriceFen({ typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: null, durationId: "month-6" }), 29900);
});

test("new dual-ISP purchase omits only Charter while shared history and other Charter remain intact", () => {
  assert.deepEqual(catalog.ispsByTypeAndRegion[base.typeId]?.us?.map((isp) => isp.id), ["ntt", "gtt", "cogent", "charter"]);
  assert.equal(catalog.ispsByTypeAndRegion["local-isp"]?.us?.find((isp) => isp.id === "us-charter")?.name, "Charter");
  const newPurchase = resolveNewPurchaseSelection({ ...base, specId: "direct-200g" }, index);
  assert.deepEqual(newPurchase.availableIsps.map((isp) => isp.id), ["ntt", "gtt", "cogent"]);
  assert.equal(newPurchase.summary.total, 49);
  const legacy = { ...base, ispId: "charter", specId: "optimized-500g" };
  const oldRow = { ...legacy, priceFen: 7900, isActive: true, soldOut: false };
  const oldIndex = { [`${legacy.typeId}|${legacy.regionId}|${legacy.ispId}|${legacy.specId}|${legacy.durationId}`]: oldRow };
  assert.equal(resolveSelection(legacy, oldIndex).summary.complete, true); // Historical reader unchanged.
  assert.equal(resolveNewPurchaseSelection(legacy, oldIndex).summary.complete, false);
  assert.equal(resolveNewPurchaseSelection(legacy, oldIndex).summary.total, null);
  assert.equal(resolveNewPurchaseSelection({ ...legacy, typeId: "local-isp", ispId: "us-charter", specId: null }).summary.complete, true);
  assert.equal(resolvePriceFen({ ...base, ispId: "charter", specId: "direct-200g" }), 4900); // Server pricing remains unchanged this round.
});

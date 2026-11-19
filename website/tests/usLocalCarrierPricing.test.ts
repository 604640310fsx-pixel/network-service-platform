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
const { resolvePriceFen } = loader.load("../auth-service/src/payment/pricing.ts") as {
  resolvePriceFen: (selection: Selection) => number | null;
};
const { monthlyPresentation } = loader.load("app/components/subscribe/subscriptionPresentation.ts") as {
  monthlyPresentation: (index: Record<string, unknown>, selection: Selection) => { monthlyFen: number; baseMonthlyFen: number | null; addonMonthlyFen: number | null } | null;
};
type Selection = { typeId: string; regionId: string; ispId: string; specId: string | null; durationId: string };
const base = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", durationId: "month-1" };
const specs = ["direct-200g", "direct-500g", "optimized-200g", "optimized-500g"] as const;
const index = {}; // Production 381 has only the fixed, spec-null dual-ISP rows.

test("production 381 dual-ISP fixed SKUs retain their exact period prices and no new spec quote", () => {
  for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
    for (const [durationId, priceFen] of [["month-1", 5900], ["month-6", 29900], ["month-12", 49900]] as const) {
      assert.equal(resolvePriceFen({ ...base, ispId, specId: null, durationId }), priceFen);
    }
    for (const specId of specs) assert.equal(resolvePriceFen({ ...base, ispId, specId }), null);
  }
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-500g", durationId: "month-6" }), null);
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-500g", ispId: "forged" }), null);
  assert.equal(resolvePriceFen({ ...base, specId: "optimized-1t" }), null);
});

test("new dual-ISP option UI shows no authoritative price without a matching server row", () => {
  assert.deepEqual(catalog.packageLinesByTypeAndRegion[base.typeId]?.us?.map((line) => line.id), ["direct", "optimized"]);
  const catalogSpecs = catalog.packageSpecsByTypeAndRegion[base.typeId]?.us ?? [];
  assert.deepEqual(Object.fromEntries(catalogSpecs.map((spec) => [spec.id, spec.surcharge])), {
    "direct-200g": 0, "direct-500g": 0, "optimized-200g": 10, "optimized-500g": 20,
  });
  for (const spec of catalogSpecs) {
    assert.equal(spec.monthlyPrice, null);
    assert.deepEqual(spec.pricesByDuration, {});
    const selection = { ...base, specId: spec.id };
    assert.equal(resolveSelection(selection, index).summary.total, null);
    assert.equal(monthlyPresentation(index, selection), null);
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
  assert.equal(newPurchase.summary.total, null);
  const legacy = { ...base, ispId: "charter", specId: "optimized-500g" };
  assert.equal(resolveNewPurchaseSelection(legacy, index).summary.complete, false);
  assert.equal(resolveNewPurchaseSelection(legacy, index).summary.total, null);
  assert.equal(resolvePriceFen({ ...base, ispId: "charter", specId: "direct-200g" }), null);
  assert.equal(resolvePriceFen({ ...base, ispId: "charter", specId: null }), 5900); // Historical fixed SKU remains in 381 pricing.
});

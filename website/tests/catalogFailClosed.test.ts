import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type PlanAvailabilityItem = {
  typeId: string;
  regionId: string;
  ispId: string;
  specId: string | null;
  durationId: string;
  priceFen: number;
  isActive: boolean;
  soldOut: boolean;
};
type PlanAvailabilityIndex = Readonly<Record<string, PlanAvailabilityItem>>;
type CatalogSelection = {
  typeId: string | null;
  regionId: string | null;
  ispId: string | null;
  specId: string | null;
  durationId: string | null;
};

function loadCommonJs(
  relativePath: string,
  resolveImport: (specifier: string) => unknown = (specifier) => {
    throw new Error(`Unexpected test import: ${specifier}`);
  },
): Record<string, unknown> {
  const sourceText = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  Function("require", "module", "exports", compiled)(resolveImport, module, module.exports);
  return module.exports;
}

const catalog = loadCommonJs("../app/lib/subscribeCatalog.ts");
const resolver = loadCommonJs("../app/lib/resolveSelection.ts", (specifier) => {
  if (specifier === "./subscribeCatalog") return catalog;
  if (specifier === "./planAvailability") {
    return {
      planAvailabilityKey: (typeId: string, regionId: string, ispId: string, specId: string | null, durationId: string) =>
        `${typeId}|${regionId}|${ispId}|${specId ?? ""}|${durationId}`,
    };
  }
  throw new Error(`Unexpected test import: ${specifier}`);
});
const resolveSelection = resolver.resolveSelection as (
  selection: CatalogSelection,
  availability?: PlanAvailabilityIndex,
) => {
  summary: { complete: boolean; total: number | null; availability: string };
  durationPrices: Record<string, number | null>;
};

const selection: CatalogSelection = {
  typeId: "residential",
  regionId: "vn",
  ispId: "vnpt-corp",
  specId: "shared-3",
  durationId: "month-1",
};

function availability(overrides: Partial<PlanAvailabilityItem> = {}): PlanAvailabilityIndex {
  const item: PlanAvailabilityItem = {
    typeId: "residential",
    regionId: "vn",
    ispId: "vnpt-corp",
    specId: "shared-3",
    durationId: "month-1",
    priceFen: 12_345,
    isActive: true,
    soldOut: false,
    ...overrides,
  };
  return {
    [`${item.typeId}|${item.regionId}|${item.ispId}|${item.specId ?? ""}|${item.durationId}`]: item,
  };
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("loading, request errors, and invalid responses cannot recover a static catalog amount", () => {
  for (const state of ["loading", "error", "invalid"] as const) {
    const resolved = resolveSelection(selection);
    assert.equal(resolved.summary.complete, true, state);
    assert.equal(resolved.summary.total, null, state);
    assert.equal(resolved.summary.availability, "unknown", state);
    assert.ok(Object.values(resolved.durationPrices).every((price) => price === null), state);
  }
});

test("missing, inactive, sold-out, and invalid-price entries fail closed", () => {
  const missing = resolveSelection(selection, {});
  assert.equal(missing.summary.total, null);
  assert.equal(missing.summary.availability, "unavailable");

  const inactive = resolveSelection(selection, availability({ isActive: false }));
  assert.equal(inactive.summary.total, null);
  assert.equal(inactive.summary.availability, "unavailable");

  const soldOut = resolveSelection(selection, availability({ soldOut: true }));
  assert.equal(soldOut.summary.total, null);
  assert.equal(soldOut.summary.availability, "sold_out");

  for (const priceFen of [0, -1, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidPrice = resolveSelection(selection, availability({ priceFen }));
    assert.equal(invalidPrice.summary.total, null, String(priceFen));
    assert.equal(invalidPrice.summary.availability, "unavailable", String(priceFen));
  }
});

test("an exact active and available server entry is the only source of the displayed total", () => {
  const resolved = resolveSelection(selection, availability({ priceFen: 12_345 }));
  assert.equal(resolved.summary.availability, "available");
  assert.equal(resolved.summary.total, 123.45);
  assert.equal(resolved.durationPrices["month-1"], 123.45);
});

test("subscribe price surfaces are authority-gated and expose a mobile-visible error state", () => {
  const page = source("../app/components/subscribe/SubscribePage.tsx");
  const summary = source("../app/components/subscribe/OrderSummary.tsx");
  const mobile = source("../app/components/subscribe/MobileOrderBar.tsx");
  const css = source("../app/components/subscribe/subscribe.css");

  assert.doesNotMatch(page, /option\.(?:startingPrice|monthlyPrice)/);
  assert.match(page, /availability\.error\s*\? copy\.priceUnavailable/);
  assert.match(source("../app/i18n/zh.ts"), /priceUnavailable: "价格暂不可用，请稍后重试"/);
  assert.match(page, /sub-price-status/);
  assert.match(css, /\.sub-section-heading \.sub-price-status/);
  assert.match(summary, /summary\.availability === "available" \? summary\.total : null/);
  assert.match(summary, /authoritativeTotal === null \? t\.subscribe\.pricePending/);
  assert.match(summary, /disabled=\{!canRequest\}/);
  assert.match(mobile, /summary\.availability === "available" && summary\.total !== null/);
  assert.match(mobile, /: t\.subscribe\.pricePending;/);
  assert.match(source("../app/i18n/zh.ts"), /pricePending: "价格待确认"/);
  assert.match(mobile, /disabled=\{!canRequest\}/);
});

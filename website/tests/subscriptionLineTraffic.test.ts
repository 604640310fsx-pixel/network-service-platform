import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createTsxLoader } from "./support/tsxModules.ts";

/* Line × traffic independence on the real useSubscriptionSelection hook, real catalogue and resolver.
   A minimal hook runtime keeps state slots across renders in call order and re-renders once after
   each handler, like a React event. Prices below are synthetic availability rows, not catalogue values. */

type Selection = { typeId: string | null; regionId: string | null; ispId: string | null; specId: string | null; durationId: string | null };
type Row = { typeId: string; regionId: string; ispId: string; specId: string | null; durationId: string; priceFen: number; isActive: boolean; soldOut: boolean };
type Hook = Selection & {
  selectedLine: { id: string } | null;
  selectedTrafficId: string | null;
  summary: { traffic: string; total: number | null; availability: string; complete: boolean };
  lineTrafficIds: (lineId: string) => string[];
  selectLine: (lineId: string) => void;
  selectTraffic: (trafficId: string) => void;
  selectRegion: (regionId: string) => void;
  selectIsp: (ispId: string) => void;
};

const loader = createTsxLoader();
const { planAvailabilityKey } = loader.load("app/lib/planAvailability.ts") as {
  planAvailabilityKey: (typeId: string, regionId: string, ispId: string, specId: string | null, durationId: string) => string;
};
const imports: Record<string, unknown> = {
  "../../lib/subscribeCatalog": loader.load("app/lib/subscribeCatalog.ts"),
  "../../lib/resolveSelection": loader.load("app/lib/resolveSelection.ts"),
};

let slots: unknown[] = [];
let cursor = 0;
const react = {
  useState<T>(initial: T) {
    const store = slots, index = cursor++;
    if (!(index in store)) store[index] = initial;
    return [store[index] as T, (next: T) => { store[index] = next; }] as const;
  },
  useRef<T>(initial: T) {
    const store = slots, index = cursor++;
    if (!(index in store)) store[index] = { current: initial };
    return store[index] as { current: T };
  },
  useMemo<T>(factory: () => T) {
    cursor += 1;
    return factory();
  },
};

const hookUrl = new URL("../app/components/subscribe/useSubscriptionSelection.ts", import.meta.url);
const hookModule = { exports: {} as Record<string, unknown> };
Function("require", "module", "exports", ts.transpileModule(readFileSync(hookUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: hookUrl.pathname,
}).outputText)((specifier: string) => {
  if (specifier === "react") return react;
  if (specifier in imports) return imports[specifier];
  throw new Error(`Unexpected import: ${specifier}`);
}, hookModule, hookModule.exports);
const useSubscriptionSelection = hookModule.exports.useSubscriptionSelection as (initial?: Selection, availability?: Record<string, Row>) => Hook;

function mount(initial: Selection, availability?: Record<string, Row>) {
  const own: unknown[] = [];
  const render = () => {
    slots = own;
    cursor = 0;
    return useSubscriptionSelection(initial, availability);
  };
  let current = render();
  return {
    get state() { return current; },
    act(handler: (hook: Hook) => void) {
      handler(current);
      current = render();
      return current;
    },
  };
}

const vn = { typeId: "residential", regionId: "vn", ispId: "vnpt-corp" } as const;
const lines = ["direct", "optimized", "highspeed", "live"] as const;
const tiers = ["200g", "300g", "1t"] as const;
const spec = (line: string, tier: string) => `res-v2-${line}-${tier}`;
// Distinct synthetic yuan per line × tier, so a total identifies exactly which tuple was quoted.
const yuan = (line: string, tier: string) => 100 + lines.indexOf(line as never) * 10 + tiers.indexOf(tier as never);

function offers(durationId = "month-1", change: (row: Row) => Row | null = (row) => row): Record<string, Row> {
  const rows = lines.flatMap((line) => tiers.map((tier) => change({
    ...vn, specId: spec(line, tier), durationId, priceFen: yuan(line, tier) * 100, isActive: true, soldOut: false,
  }))).filter((row): row is Row => row !== null);
  return Object.fromEntries(rows.map((row) => [planAvailabilityKey(row.typeId, row.regionId, row.ispId, row.specId, row.durationId), row]));
}

function assertLineSwitchKeepsTier(tier: "300g" | "1t") {
  for (const from of lines) {
    for (const to of lines) {
      const page = mount({ ...vn, specId: spec(from, tier), durationId: "month-1" }, offers());
      assert.equal(page.state.selectedTrafficId, tier);
      const after = page.act((hook) => hook.selectLine(to));
      assert.equal(after.specId, spec(to, tier), `${spec(from, tier)} → line ${to}`);
      assert.equal(after.selectedLine?.id, to);
      assert.equal(after.selectedTrafficId, tier);
      assert.equal(after.durationId, "month-1");
      assert.equal(after.summary.traffic, tier === "1t" ? "1T" : "300G");
      assert.equal(after.summary.availability, "available");
      assert.equal(after.summary.total, yuan(to, tier));
    }
  }
  // The same tier survives a click-through of every line on one mounted page.
  const page = mount({ ...vn, specId: spec("direct", tier), durationId: "month-1" }, offers());
  for (const line of ["optimized", "highspeed", "live", "direct"]) {
    assert.equal(page.act((hook) => hook.selectLine(line)).specId, spec(line, tier));
  }
}

test("residential lines offer the same 200G/300G/1T tiers the traffic cards show", () => {
  const page = mount({ ...vn, specId: spec("direct", "300g"), durationId: "month-1" });
  for (const line of lines) assert.deepEqual(page.state.lineTrafficIds(line), ["200g", "300g", "1t"]);
});

test("VN/VNPT 300G stays selected when switching between all four lines", () => {
  assertLineSwitchKeepsTier("300g");
});

test("VN/VNPT 1T stays selected when switching between all four lines", () => {
  assertLineSwitchKeepsTier("1t");
});

test("switching traffic keeps the current line", () => {
  for (const line of lines) {
    const page = mount({ ...vn, specId: spec(line, "200g"), durationId: "month-1" }, offers());
    for (const tier of ["300g", "1t", "200g"]) {
      const state = page.act((hook) => hook.selectTraffic(tier));
      assert.equal(state.specId, spec(line, tier));
      assert.equal(state.selectedLine?.id, line);
      assert.equal(state.summary.total, yuan(line, tier));
    }
  }
});

test("an unavailable line × tier stays selected, unpriced and unorderable instead of falling back", () => {
  const index = offers("month-1", (row) =>
    row.specId === spec("live", "300g") ? { ...row, soldOut: true }
      : row.specId === spec("optimized", "300g") ? { ...row, isActive: false }
        : row.specId === spec("highspeed", "300g") ? null : row);
  const page = mount({ ...vn, specId: spec("direct", "300g"), durationId: "month-1" }, index);
  assert.equal(page.state.summary.availability, "available");
  for (const [line, status] of [["live", "sold_out"], ["optimized", "unavailable"], ["highspeed", "unavailable"]] as const) {
    const state = page.act((hook) => hook.selectLine(line));
    assert.equal(state.specId, spec(line, "300g"));
    assert.equal(state.selectedTrafficId, "300g");
    // SubscribePage only allows ordering with a server total and availability "available".
    assert.equal(state.summary.total, null);
    assert.equal(state.summary.availability, status);
  }
  const back = page.act((hook) => hook.selectLine("direct"));
  assert.equal(back.specId, spec("direct", "300g"));
  assert.equal(back.summary.total, yuan("direct", "300g"));
});

test("link restore, selected period and country/ISP invalidation are unchanged", () => {
  const page = mount({ ...vn, specId: spec("highspeed", "300g"), durationId: "month-3" }, offers("month-3"));
  assert.equal(page.state.specId, spec("highspeed", "300g"));
  assert.equal(page.state.durationId, "month-3");
  assert.equal(page.act((hook) => hook.selectLine("live")).durationId, "month-3");
  assert.equal(page.act((hook) => hook.selectTraffic("1t")).durationId, "month-3");
  // A new country clears the ISP until it is chosen again; the line × tier and period are then re-validated.
  const moved = page.act((hook) => hook.selectRegion("sg"));
  assert.equal(moved.ispId, null);
  assert.equal(moved.summary.complete, false);
  const reselected = page.act((hook) => hook.selectIsp("sptel"));
  assert.equal(reselected.specId, spec("live", "1t"));
  assert.equal(reselected.durationId, "month-3");
});

test("non-residential packages keep their own 200G/500G/1T tiers and catalogue-only lines", () => {
  const us = mount({ typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: "half-500g", durationId: "month-1" });
  assert.equal(us.act((hook) => hook.selectLine("high")).specId, "high-500g");
  assert.equal(us.act((hook) => hook.selectLine("ordinary")).specId, "ordinary-500g");
  // Southeast Asia's live line only exists as 1T in the catalogue; leaving it keeps 1T.
  const sea = mount({ typeId: "local-isp", regionId: "vn", ispId: "vn-fpt", specId: "half-200g", durationId: "month-1" });
  assert.equal(sea.act((hook) => hook.selectLine("live")).specId, "live-1t");
  assert.equal(sea.act((hook) => hook.selectLine("half")).specId, "half-1t");
});

test("dual-ISP direct/optimized switching preserves traffic and switching traffic preserves line", () => {
  const page = mount({ typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: "direct-200g", durationId: "month-1" });
  assert.deepEqual(page.state.lineTrafficIds("direct"), ["200g", "500g"]);
  assert.deepEqual(page.state.lineTrafficIds("optimized"), ["200g", "500g"]);
  assert.equal(page.act((hook) => hook.selectLine("optimized")).specId, "optimized-200g");
  assert.equal(page.act((hook) => hook.selectTraffic("500g")).specId, "optimized-500g");
  assert.equal(page.act((hook) => hook.selectLine("direct")).specId, "direct-500g");
  assert.equal(page.act((hook) => hook.selectTraffic("200g")).specId, "direct-200g");
  assert.equal(page.state.durationId, "month-1");
});

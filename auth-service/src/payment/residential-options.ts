import type { DatabaseConnection } from "../db.js";
import type { PlanSelection } from "./commerce.js";

export const RESIDENTIAL_OPTIONS_VERSION = "residential-options-v2";
export const RESIDENTIAL_PRICING_STRATEGY = "original-traffic-tier-v2";
export const RESIDENTIAL_DEFAULT_SPEC = "res-v2-direct-200g";
export const RESIDENTIAL_LEGACY_DIRECT_SPEC = "res-v2-direct-default";
export const RESIDENTIAL_VARIANTS = [
  // Historical300G snapshots remain readable, never silently re-priced.
  { specId: RESIDENTIAL_LEGACY_DIRECT_SPEC, lineId: "direct", trafficGb: 300, deviceAllowance: null, addonMonthlyFen: 0 },
  ...([200,300,1000] as const).map((trafficGb,index)=>({specId:`res-v2-direct-${["200g","300g","1t"][index]}`,lineId:"direct",trafficGb,deviceAllowance:[3,5,10][index]!,addonMonthlyFen:0})),
  ...(["optimized", "highspeed", "live"] as const).flatMap((lineId, lineIndex) =>
    ([200, 300, 1000] as const).map((trafficGb, index) => ({
      specId: `res-v2-${lineId}-${["200g", "300g", "1t"][index]}`,
      lineId, trafficGb, deviceAllowance: [3, 5, 10][index]!,
      addonMonthlyFen: [[1000, 1200, 3000], [2000, 2500, 7000], [3000, 3500, 10000]][lineIndex]![index]!,
    }))),
] as const;

export interface ResidentialOptions {
  readonly version: typeof RESIDENTIAL_OPTIONS_VERSION;
  readonly typeId: "residential";
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string;
  readonly durationId: string;
  readonly basePlanId: number;
  readonly baseMonthlyFen: number;
  readonly addonMonthlyFen: number;
  readonly finalMonthlyFen: number;
  readonly lineId: string;
  readonly trafficGb: number;
  readonly deviceAllowance: number | null;
  readonly pricingStrategyVersion?: typeof RESIDENTIAL_PRICING_STRATEGY | "original-traffic-tier-v1";
  readonly basePeriodFen?: number;
  readonly addonPeriodFen?: number;
  readonly finalPeriodFen?: number;
}
const KEYS = ["version", "typeId", "regionId", "ispId", "specId", "durationId", "basePlanId", "baseMonthlyFen", "addonMonthlyFen", "finalMonthlyFen", "lineId", "trafficGb", "deviceAllowance"].sort().join(",");
const CURRENT_KEYS = `${KEYS},pricingStrategyVersion,basePeriodFen,addonPeriodFen,finalPeriodFen`.split(",").sort().join(",");
const RATIOS: Record<string, readonly [number, number]> = {
  "month-1": [1, 1], "month-3": [27, 10], "month-6": [51, 10], "month-12": [48, 5],
};
export function isResidentialV2(selection: Pick<PlanSelection, "typeId" | "specId">): boolean {
  return selection.typeId === "residential" && typeof selection.specId === "string" && selection.specId.startsWith("res-v2-");
}
export function residentialVariant(specId: string | null) {
  return RESIDENTIAL_VARIANTS.find(item => item.specId === specId) ?? null;
}
function historicalResidentialVariant(specId:string|null){
  const oldLine=/^res-v2-(direct|optimized|highspeed|live)-500g$/.exec(specId??'')?.[1];
  return oldLine ? {specId:specId!,lineId:oldLine,trafficGb:500,deviceAllowance:oldLine==='direct'?null:5,
    addonMonthlyFen:({direct:1000,optimized:2000,highspeed:4000,live:6000}as Record<string,number>)[oldLine]!} : residentialVariant(specId);
}
export function residentialPeriodPrice(monthlyFen: number, durationId: string): number {
  const ratio = RATIOS[durationId];
  if (!ratio || !Number.isSafeInteger(monthlyFen) || monthlyFen < 0) throw new Error("Residential options invariant failed");
  if (durationId === "month-1") return monthlyFen;
  const numerator = monthlyFen * ratio[0];
  if (!Number.isSafeInteger(numerator + ratio[1] * 50)) throw new Error("Residential amount overflow");
  return Math.floor((numerator + ratio[1] * 50) / (ratio[1] * 100)) * 100;
}
export function residentialBaseSpec(specId: string | null): "shared-5" | "shared-3" | "dedicated" | null {
  if(specId===RESIDENTIAL_LEGACY_DIRECT_SPEC)return null;
  const variant = residentialVariant(specId);
  return variant?.trafficGb === 200 ? "shared-5" : variant?.trafficGb === 300 ? "shared-3" : variant?.trafficGb === 1000 ? "dedicated" : null;
}
export function isCurrentResidentialPricing(snapshot: ResidentialOptions): boolean {
  return snapshot.pricingStrategyVersion === RESIDENTIAL_PRICING_STRATEGY || snapshot.pricingStrategyVersion === "original-traffic-tier-v1";
}
export function createResidentialOptions(selection: PlanSelection, basePlanId: number, baseMonthlyFen: number, basePeriodFen: number): ResidentialOptions {
  const variant = residentialVariant(selection.specId);
  if (!isResidentialV2(selection) || !variant || !RATIOS[selection.durationId] ||
    typeof selection.regionId !== "string" || !selection.regionId || typeof selection.ispId !== "string" || !selection.ispId ||
    !residentialBaseSpec(selection.specId) || !Number.isSafeInteger(basePeriodFen) || basePeriodFen <= 0 ||
    !Number.isSafeInteger(basePlanId) || basePlanId <= 0 || !Number.isSafeInteger(baseMonthlyFen) || baseMonthlyFen <= 0) throw new Error("Residential options invariant failed");
  const finalMonthlyFen = baseMonthlyFen + variant.addonMonthlyFen;
  if (!Number.isSafeInteger(finalMonthlyFen) || !Number.isSafeInteger(basePeriodFen + residentialPeriodPrice(variant.addonMonthlyFen, selection.durationId))) throw new Error("Residential amount overflow");
  return { version: RESIDENTIAL_OPTIONS_VERSION, typeId: "residential", regionId: selection.regionId, ispId: selection.ispId,
    specId: variant.specId, durationId: selection.durationId, basePlanId, baseMonthlyFen,
    addonMonthlyFen: variant.addonMonthlyFen, finalMonthlyFen, lineId: variant.lineId, trafficGb: variant.trafficGb,
    deviceAllowance: variant.deviceAllowance, pricingStrategyVersion: RESIDENTIAL_PRICING_STRATEGY,
    basePeriodFen, addonPeriodFen: residentialPeriodPrice(variant.addonMonthlyFen, selection.durationId),
    finalPeriodFen: basePeriodFen + residentialPeriodPrice(variant.addonMonthlyFen, selection.durationId) };
}
export function parseResidentialOptions(raw: unknown, selection: PlanSelection, catalogVersion?: unknown): ResidentialOptions | null {
  if (!isResidentialV2(selection)) {
    if (raw !== null && raw !== undefined) throw new Error("Unexpected residential snapshot on legacy order");
    return null;
  }
  if (typeof raw !== "string" || (catalogVersion !== undefined && catalogVersion !== RESIDENTIAL_OPTIONS_VERSION)) throw new Error("Missing residential v2 snapshot");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Corrupt residential snapshot"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Corrupt residential snapshot");
  const value = parsed as ResidentialOptions;
  const keys = Object.keys(value).sort().join(",");
  let expected: ResidentialOptions;
  if (keys === CURRENT_KEYS) {
    expected = createResidentialOptions(selection, value.basePlanId, value.baseMonthlyFen, value.basePeriodFen!);
    if(value.pricingStrategyVersion==='original-traffic-tier-v1')expected={...expected,pricingStrategyVersion:'original-traffic-tier-v1',deviceAllowance:expected.lineId==='direct'?null:expected.deviceAllowance};
    if (!Number.isSafeInteger(expected.finalPeriodFen)) throw new Error("Residential amount overflow");
  } else if (keys === KEYS) {
    // Read historical local snapshots without repricing them. They are NOT eligible
    // for new retry/renewal quotes under the corrected commercial strategy.
    const variant = historicalResidentialVariant(selection.specId);
    if (!variant || !RATIOS[selection.durationId] || !selection.regionId || !selection.ispId ||
      !Number.isSafeInteger(value.basePlanId) || value.basePlanId <= 0 || !Number.isSafeInteger(value.baseMonthlyFen) || value.baseMonthlyFen <= 0)
      throw new Error("Corrupt residential snapshot");
    const addonMonthlyFen = variant.lineId === "direct" ? (variant.trafficGb === 500 ? 1000 : variant.trafficGb === 1000 ? 2000 : 0) : variant.addonMonthlyFen;
    expected = {version:RESIDENTIAL_OPTIONS_VERSION,typeId:"residential",regionId:selection.regionId,ispId:selection.ispId,
      specId:variant.specId,durationId:selection.durationId,basePlanId:value.basePlanId,baseMonthlyFen:value.baseMonthlyFen,
      addonMonthlyFen,finalMonthlyFen:value.baseMonthlyFen+addonMonthlyFen,lineId:variant.lineId,trafficGb:variant.trafficGb,deviceAllowance:variant.lineId==='direct'?null:variant.deviceAllowance};
  } else throw new Error("Corrupt residential snapshot");
  for (const key of Object.keys(expected) as Array<keyof ResidentialOptions>) {
    if (value[key] !== expected[key]) throw new Error("Conflicting residential snapshot");
  }
  return expected;
}
/** Historical <=030 fixtures remain supported; a marked031 schema missing its column is corruption. */
export function residentialSnapshotSql(db: DatabaseConnection, prefix = "orders"): string {
  const exists = db.prepare("PRAGMA table_info(orders)").all().some(row => (row as { name: string }).name === "residential_options_json");
  if (exists) return `${prefix}.residential_options_json`;
  const hasLedger = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").all().length === 1;
  const rows = hasLedger ? db.prepare("SELECT MAX(version) AS version FROM schema_migrations").all() as Array<{ version: number | null }> : [];
  if ((rows[0]?.version ?? 0) >= 31) throw new Error("Residential snapshot schema missing");
  return "NULL";
}
export function residentialOptionsFromOrderRow(row: Record<string, unknown>): ResidentialOptions | null {
  return parseResidentialOptions(row.residential_options_json, {
    typeId: row.type_id as string, regionId: row.region_id as string, ispId: row.isp_id as string,
    specId: row.spec_id as string | null, durationId: row.duration_id as string,
  }, row.catalog_version);
}
export function residentialOptionsForOrder(db: DatabaseConnection, orderRef: string): ResidentialOptions | null {
  const rows = db.prepare(`SELECT type_id,region_id,isp_id,spec_id,duration_id,catalog_version,
    ${residentialSnapshotSql(db)} AS residential_options_json FROM orders WHERE order_ref=?`).all(orderRef) as Record<string, unknown>[];
  if (rows.length !== 1) throw new Error("Residential order snapshot unavailable");
  const parsed = residentialOptionsFromOrderRow(rows[0]!);
  if (parsed) assertResidentialSnapshotAnchor(db, parsed);
  return parsed;
}
export function assertResidentialSnapshotAnchor(db: DatabaseConnection, snapshot: ResidentialOptions): void {
  const rows = db.prepare("SELECT type_id,region_id,isp_id,spec_id,duration_id FROM sellable_plans WHERE id=?").all(snapshot.basePlanId) as Record<string, unknown>[];
  const row = rows[0];
  if (rows.length !== 1 || !row || row.type_id !== "residential" || row.region_id !== snapshot.regionId || row.isp_id !== snapshot.ispId ||
    row.spec_id !== (isCurrentResidentialPricing(snapshot) ? residentialBaseSpec(snapshot.specId) : "shared-3") || row.duration_id !== snapshot.durationId) throw new Error("Residential snapshot anchor conflict");
}
export function residentialOrderFields(db: DatabaseConnection, orderRef: string): { residentialOptions?: ResidentialOptions } {
  const residentialOptions = residentialOptionsForOrder(db, orderRef);
  return residentialOptions ? { residentialOptions } : {};
}

// @ts-ignore TS5097: Node strip-types tests and Vite consume the same source.
import { residentialV2Specs, residentialHistoricalSpecs } from "./subscribeCatalog.ts";
export type ResidentialOptions = {
  version: "residential-options-v2"; typeId: "residential"; regionId: string; ispId: string; specId: string; durationId: string;
  basePlanId: number; baseMonthlyFen: number; addonMonthlyFen: number; finalMonthlyFen: number;
  lineId: string; trafficGb: number; deviceAllowance: number | null;
  pricingStrategyVersion?: "original-traffic-tier-v1" | "original-traffic-tier-v2";
  basePeriodFen?: number; addonPeriodFen?: number; finalPeriodFen?: number;
};
const KEYS = ["version","typeId","regionId","ispId","specId","durationId","basePlanId","baseMonthlyFen","addonMonthlyFen","finalMonthlyFen","lineId","trafficGb","deviceAllowance"].sort().join(",");
export function parseResidentialOptions(value: unknown): ResidentialOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid residential options response");
  const item = value as ResidentialOptions, spec = [...residentialV2Specs,...residentialHistoricalSpecs].find(option => option.id === item.specId);
  const keys=Object.keys(value).sort().join(","),current=keys===`${KEYS},pricingStrategyVersion,basePeriodFen,addonPeriodFen,finalPeriodFen`.split(",").sort().join(",");
  if(!current && keys!==KEYS) throw new Error("Invalid residential options response");
  const expectedAddon=!current && spec?.lineId==='direct' ? spec.trafficId==='500g'?1000:spec.trafficId==='1t'?2000:0 : (spec?.surcharge??0)*100;
  const expectedDevice=spec?.lineId==='direct'&&(!current||item.pricingStrategyVersion==='original-traffic-tier-v1')?null:spec?.deviceAllowance;
  if (!spec || item.version !== "residential-options-v2" || item.typeId !== "residential" ||
    !item.regionId || typeof item.regionId !== "string" || !item.ispId || typeof item.ispId !== "string" ||
    !["month-1","month-3","month-6","month-12"].includes(item.durationId) ||
    !Number.isSafeInteger(item.basePlanId) || item.basePlanId <= 0 || !Number.isSafeInteger(item.baseMonthlyFen) || item.baseMonthlyFen <= 0 ||
    item.addonMonthlyFen !== expectedAddon || !Number.isSafeInteger(item.finalMonthlyFen) ||
    item.finalMonthlyFen !== item.baseMonthlyFen + item.addonMonthlyFen || item.lineId !== spec.lineId ||
    item.trafficGb !== (spec.trafficId === "1t" ? 1000 : Number.parseInt(spec.trafficId ?? "",10)) || item.deviceAllowance !== expectedDevice)
    throw new Error("Conflicting residential options response");
  if(current){
    const ratio:Record<string,readonly[number,number]>={'month-1':[1,1],'month-3':[27,10],'month-6':[51,10],'month-12':[48,5]},[n,d]=ratio[item.durationId]!;
    const addon=item.durationId==='month-1'?item.addonMonthlyFen:Math.floor((item.addonMonthlyFen*n+d*50)/(d*100))*100;
    if(!['original-traffic-tier-v1','original-traffic-tier-v2'].includes(item.pricingStrategyVersion??'')||![200,300,1000].includes(item.trafficGb)||item.specId==='res-v2-direct-default'||
      !Number.isSafeInteger(item.basePeriodFen)||item.basePeriodFen!<=0||item.addonPeriodFen!==addon||
      !Number.isSafeInteger(item.finalPeriodFen)||item.finalPeriodFen!==item.basePeriodFen!+addon)throw new Error('Conflicting residential period response');
  }
  return item;
}
export function residentialResponseFields(value: Record<string, unknown>): { residentialOptions?: ResidentialOptions } {
  if (value.typeId === "residential" && typeof value.specId === "string" && value.specId.startsWith("res-v2-") && value.residentialOptions === undefined)
    throw new Error("Missing residential options response");
  const parsed = parseResidentialOptions(value.residentialOptions);
  if (parsed) for (const key of ["typeId","regionId","ispId","specId","durationId"] as const) {
    if (value[key] !== undefined && value[key] !== parsed[key]) throw new Error("Residential response tuple conflict");
  }
  return parsed ? { residentialOptions: parsed } : {};
}

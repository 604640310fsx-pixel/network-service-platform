import { planAvailabilityKey, type PlanAvailabilityIndex } from "../../lib/planAvailability";
import type { CatalogSelection } from "../../lib/resolveSelection";

/** Display only. Every amount comes from the current server catalogue, never
 * the static marketing catalogue or a locally reconstructed period discount. */
export function monthlyPresentation(index: PlanAvailabilityIndex | null, selection: CatalogSelection) {
  const { typeId, regionId, ispId, specId } = selection;
  if (!index || !typeId || !regionId || !ispId) return null;
  const row = index[planAvailabilityKey(typeId, regionId, ispId, specId, "month-1")];
  if (!row?.isActive || row.soldOut) return null;
  if (row.residentialOptions) return {
    monthlyFen: row.priceFen,
    baseMonthlyFen: row.residentialOptions.baseMonthlyFen,
    addonMonthlyFen: row.residentialOptions.addonMonthlyFen,
  };
  const baseSpec = typeId === "local-isp" ? null
    : typeId === "pure-native-ip" && specId ? `ordinary-${specId.split("-").at(-1)}` : specId;
  const base = index[planAvailabilityKey(typeId, regionId, ispId, baseSpec, "month-1")];
  return {
    monthlyFen: row.priceFen,
    baseMonthlyFen: base?.isActive && !base.soldOut && base.priceFen <= row.priceFen ? base.priceFen : null,
    addonMonthlyFen: base?.isActive && !base.soldOut && base.priceFen <= row.priceFen ? row.priceFen - base.priceFen : null,
  };
}
export type MonthlyPresentation = ReturnType<typeof monthlyPresentation>;

import { useMemo, useRef, useState } from "react";
import {
  defaultCatalogSelection,
  LOCAL_ISP_BASE_LINE_ID,
  LOCAL_ISP_BASE_TRAFFIC_ID,
  residentialTrafficOptions,
  trafficOptions,
} from "../../lib/subscribeCatalog";
import {
  resolveSelection,
  withImpliedIsp,
  withPackageDefaults,
  type CatalogSelection,
} from "../../lib/resolveSelection";
import type { PlanAvailabilityIndex } from "../../lib/planAvailability";

// SelectionSummary 的真源已迁到 resolveSelection；此处继续 re-export，
// 让 OrderSummary / MobileOrderBar / RequirementForm 的现有引用保持不变。
export type { SelectionSummary } from "../../lib/resolveSelection";

// 根据可选的初始选择决定播种：仅当初始选择解析为完整方案时采纳（并把光标落在
// 最后"确认并提交"步骤）；否则——包括无初始参数或不完整/非法参数——沿用现有
// defaultCatalogSelection 与默认步骤，行为与改动前逐字节一致。
function seedSelection(initial?: CatalogSelection): { selection: CatalogSelection; step: number } {
  if (initial) {
    const resolved = resolveSelection(initial);
    if (resolved.summary.complete) {
      return {
        selection: {
          typeId: initial.typeId,
          regionId: initial.regionId,
          ispId: initial.ispId,
          specId: resolved.selectedSpec ? initial.specId : null,
          durationId: initial.durationId,
        },
        step: resolved.hasSpecStep ? 6 : 5,
      };
    }
    // 不完整但类型有效（如缺 duration 的分享链接）：保留依赖链上已有效的前缀，光标落在第一个缺失的步骤，
    // 不静默回退到默认方案。
    if (resolved.selectedType) {
      // A / B：地区 + 运营商已合法时，缺失的线路 × 流量 / 有效期补成默认路线 / 普通路线 200G、月付；显式的合法部分保留。
      const prefix: CatalogSelection = {
        typeId: initial.typeId,
        regionId: resolved.selectedRegion ? initial.regionId : null,
        ispId: resolved.selectedRegion && resolved.selectedIsp ? initial.ispId : null,
        specId: resolved.selectedRegion && resolved.selectedIsp && resolved.selectedSpec ? initial.specId : null,
        durationId: null,
      };
      const defaulted = withPackageDefaults({ ...prefix, durationId: initial.durationId });
      const defaultedResolved = resolveSelection(defaulted);
      if (defaultedResolved.summary.complete) {
        return { selection: defaulted, step: defaultedResolved.hasSpecStep ? 6 : 5 };
      }
      const selection = prefix;
      const partial = resolveSelection(selection);
      // 步骤：1 类型 → 2 地区 → 3 运营商 → [4 规格] → 有效期（有规格步为 5，否则为 4）。
      const durationStep = partial.hasSpecStep ? 5 : 4;
      const step = !selection.regionId ? 2 : !selection.ispId ? 3 : partial.canSelectDuration ? durationStep : 4;
      return { selection, step };
    }
  }
  return { selection: { ...defaultCatalogSelection }, step: 5 };
}

export function useSubscriptionSelection(
  initial?: CatalogSelection,
  availability?: PlanAvailabilityIndex,
) {
  const seed = useRef(seedSelection(initial)).current;
  const [typeId, setTypeId] = useState<string | null>(seed.selection.typeId);
  const [regionId, setRegionId] = useState<string | null>(seed.selection.regionId);
  const [ispId, setIspId] = useState<string | null>(seed.selection.ispId);
  const [specId, setSpecId] = useState<string | null>(seed.selection.specId);
  const [durationId, setDurationId] = useState<string | null>(seed.selection.durationId);
  const [currentStep, setCurrentStep] = useState(seed.step);

  const resolved = useMemo(
    () => resolveSelection({ typeId, regionId, ispId, specId, durationId }, availability),
    [typeId, regionId, ispId, specId, durationId, availability],
  );

  const {
    requiresSpec,
    hasSpecStep,
    availableRegions,
    availableIsps,
    availableSpecs,
    availableLines,
    availableDurations,
    selectedSpec,
    selectedLine,
    selectedTrafficId,
    canSelectDuration,
    durationPrices,
    durationAvailability,
    summary,
  } = resolved;

  // 本地ISP运营商 / 纯净原生独享 IP：选定地区 + 运营商后带默认线路 × 流量与月付（见 withPackageDefaults）。
  const isPackageType = typeId === "local-isp" || typeId === "pure-native-ip" || typeId === "residential" || typeId === "us-local-carrier";

  function selectType(nextId: string) {
    if (nextId === typeId) return;
    setTypeId(nextId);
    setRegionId(null);
    setIspId(null);
    setSpecId(null);
    setDurationId(null);
    setCurrentStep(2);
  }

  function selectRegion(nextId: string) {
    // impliedIsp 类型（纯净原生独享 IP）：地区唯一对应的 ispId 直接带上，跳过运营商确认，进入线路与流量。
    const impliedIspId = withImpliedIsp({ typeId, regionId: nextId, ispId: null, specId: null, durationId: null }).ispId;
    setRegionId(nextId);
    setIspId(impliedIspId);
    if (isPackageType && impliedIspId) {
      // B：地区即确定 IP 项；保留在新地区仍合法的线路 × 流量 / 有效期，否则落到普通路线 200G、月付。
      const next = withPackageDefaults({ typeId, regionId: nextId, ispId: impliedIspId, specId, durationId });
      setSpecId(next.specId);
      setDurationId(next.durationId);
    } else if (!isPackageType) {
      setSpecId(null);
      setDurationId(null);
    }
    // A：运营商尚未选，线路 × 流量 / 有效期暂留，选运营商时再按新地区校验（不合法的落到默认值）。
    setCurrentStep(impliedIspId ? 4 : 3);
  }

  function selectIsp(nextId: string) {
    setIspId(nextId);
    if (isPackageType) {
      const next = withPackageDefaults({ typeId, regionId, ispId: nextId, specId, durationId });
      setSpecId(next.specId);
      setDurationId(next.durationId);
    } else {
      setSpecId(null);
      setDurationId(null);
    }
    setCurrentStep(4);
  }

  function selectSpec(nextId: string | null) {
    setSpecId(nextId);
    // A / B 的每个线路 × 流量都提供同一组周期：手动换线路 / 流量时保留已选有效期；真住宅宽带沿用原行为重新选。
    if (!isPackageType) setDurationId(null);
    setCurrentStep(5);
  }

  /* 线路 × 流量：一个套餐只选一个地区、一条线路、一档流量。切换线路时尽量保留当前流量档，
     该线路没有这一档（例如直播专线仅限 1T）时落到该线路的第一档。
     "现有线路 + 200G" 对应现有套餐本身，specId 为 null。 */
  function packageSpecId(lineId: string, trafficId: string): string | null | undefined {
    if (!requiresSpec && lineId === LOCAL_ISP_BASE_LINE_ID && trafficId === LOCAL_ISP_BASE_TRAFFIC_ID) return null;
    return availableSpecs.find((option) => option.lineId === lineId && option.trafficId === trafficId)?.id;
  }

  // 换线路时在这组档位里保留当前流量档，须与订阅页流量卡一致（真住宅宽带 200G / 300G / 1T，其余 200G / 500G / 1T）。
  const packageTrafficOptions = typeId === "residential" ? residentialTrafficOptions : trafficOptions;

  function lineTrafficIds(lineId: string): string[] {
    return packageTrafficOptions
      .map((option) => option.id)
      .filter((trafficId) => packageSpecId(lineId, trafficId) !== undefined);
  }

  function selectLine(lineId: string) {
    const trafficIds = lineTrafficIds(lineId);
    const trafficId = selectedTrafficId && trafficIds.includes(selectedTrafficId) ? selectedTrafficId : trafficIds[0];
    if (trafficId === undefined) return;
    selectSpec(packageSpecId(lineId, trafficId) ?? null);
  }

  function selectTraffic(trafficId: string) {
    if (!selectedLine) return;
    const nextId = packageSpecId(selectedLine.id, trafficId);
    if (nextId === undefined) return;
    selectSpec(nextId);
  }

  function selectDuration(nextId: string) {
    setDurationId(nextId);
    setCurrentStep(hasSpecStep ? 6 : 5);
  }

  return {
    typeId,
    regionId,
    ispId,
    specId,
    durationId,
    currentStep,
    setCurrentStep,
    requiresSpec,
    hasSpecStep,
    availableRegions,
    availableIsps,
    availableSpecs,
    availableLines,
    availableDurations,
    durationPrices,
    durationAvailability,
    selectedSpec,
    selectedLine,
    selectedTrafficId,
    canSelectDuration,
    summary,
    lineTrafficIds,
    packageSpecId,
    selectType,
    selectRegion,
    selectIsp,
    selectSpec,
    selectLine,
    selectTraffic,
    selectDuration,
  };
}

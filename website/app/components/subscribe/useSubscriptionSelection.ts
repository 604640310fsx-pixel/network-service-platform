import { useMemo, useRef, useState } from "react";
import { defaultCatalogSelection } from "../../lib/subscribeCatalog";
import { resolveSelection, type CatalogSelection } from "../../lib/resolveSelection";
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
          specId: resolved.requiresSpec ? initial.specId : null,
          durationId: initial.durationId,
        },
        step: resolved.requiresSpec ? 6 : 5,
      };
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
    availableRegions,
    availableIsps,
    availableSpecs,
    availableDurations,
    selectedSpec,
    canSelectDuration,
    durationPrices,
    durationAvailability,
    summary,
  } = resolved;

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
    setRegionId(nextId);
    setIspId(null);
    setSpecId(null);
    setDurationId(null);
    setCurrentStep(3);
  }

  function selectIsp(nextId: string) {
    setIspId(nextId);
    setSpecId(null);
    setDurationId(null);
    setCurrentStep(4);
  }

  function selectSpec(nextId: string) {
    setSpecId(nextId);
    setDurationId(null);
    setCurrentStep(5);
  }

  function selectDuration(nextId: string) {
    setDurationId(nextId);
    setCurrentStep(requiresSpec ? 6 : 5);
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
    availableRegions,
    availableIsps,
    availableSpecs,
    availableDurations,
    durationPrices,
    durationAvailability,
    selectedSpec,
    canSelectDuration,
    summary,
    selectType,
    selectRegion,
    selectIsp,
    selectSpec,
    selectDuration,
  };
}

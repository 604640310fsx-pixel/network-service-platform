import { useMemo, useState } from "react";
import {
  defaultPrototypeSelection,
  durations,
  ispsByRegion,
  networkTypes,
  regions,
  specsByIsp,
} from "../../lib/subscribeCatalog";

export type SelectionSummary = {
  type: string;
  region: string;
  isp: string;
  spec: string;
  duration: string;
  traffic: string;
  total: number | null;
  listPrice: number | null;
  complete: boolean;
};

export function useSubscriptionSelection() {
  const [typeId, setTypeId] = useState<string | null>(defaultPrototypeSelection.typeId);
  const [regionId, setRegionId] = useState<string | null>(defaultPrototypeSelection.regionId);
  const [ispId, setIspId] = useState<string | null>(defaultPrototypeSelection.ispId);
  const [specId, setSpecId] = useState<string | null>(defaultPrototypeSelection.specId);
  const [durationId, setDurationId] = useState<string | null>(defaultPrototypeSelection.durationId);
  const [currentStep, setCurrentStep] = useState(5);

  const availableIsps = regionId ? (ispsByRegion[regionId] ?? []) : [];
  const availableSpecs = ispId ? (specsByIsp[ispId] ?? []) : [];

  const selectedType = networkTypes.find((option) => option.id === typeId) ?? null;
  const selectedRegion = regions.find((option) => option.id === regionId) ?? null;
  const selectedIsp = availableIsps.find((option) => option.id === ispId) ?? null;
  const selectedSpec = availableSpecs.find((option) => option.id === specId) ?? null;
  const selectedDuration = durations.find((option) => option.id === durationId) ?? null;

  const summary = useMemo<SelectionSummary>(() => {
    const complete = Boolean(selectedType && selectedRegion?.configured && selectedIsp && selectedSpec && selectedDuration);
    const listPrice = complete ? selectedSpec!.monthlyPrice * selectedDuration!.months : null;
    const total = complete
      ? Math.round(selectedSpec!.monthlyPrice * selectedDuration!.months * selectedDuration!.rate)
      : null;

    return {
      type: selectedType?.name ?? "—",
      region: selectedRegion?.name ?? "—",
      isp: selectedIsp?.name ?? "—",
      spec: selectedSpec?.name ?? "—",
      duration: selectedDuration?.name ?? "—",
      traffic: selectedSpec?.traffic ?? "—",
      listPrice,
      total,
      complete,
    };
  }, [selectedDuration, selectedIsp, selectedRegion, selectedSpec, selectedType]);

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
    setCurrentStep(6);
  }

  return {
    typeId,
    regionId,
    ispId,
    specId,
    durationId,
    currentStep,
    setCurrentStep,
    availableIsps,
    availableSpecs,
    selectedSpec,
    summary,
    selectType,
    selectRegion,
    selectIsp,
    selectSpec,
    selectDuration,
  };
}

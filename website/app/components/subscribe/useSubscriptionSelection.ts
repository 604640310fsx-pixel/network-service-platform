import { useMemo, useState } from "react";
import {
  defaultCatalogSelection,
  durationsByType,
  ispsByTypeAndRegion,
  networkTypes,
  regionsByType,
  specsByIsp,
} from "../../lib/subscribeCatalog";

export type SelectionSummary = {
  type: string;
  region: string;
  isp: string;
  spec: string;
  duration: string;
  traffic: string;
  bandwidth: string;
  ipType: string;
  udp: string;
  dns: string;
  total: number | null;
  listPrice: number | null;
  complete: boolean;
};

export function useSubscriptionSelection() {
  const [typeId, setTypeId] = useState<string | null>(defaultCatalogSelection.typeId);
  const [regionId, setRegionId] = useState<string | null>(defaultCatalogSelection.regionId);
  const [ispId, setIspId] = useState<string | null>(defaultCatalogSelection.ispId);
  const [specId, setSpecId] = useState<string | null>(defaultCatalogSelection.specId);
  const [durationId, setDurationId] = useState<string | null>(defaultCatalogSelection.durationId);
  const [currentStep, setCurrentStep] = useState(5);

  const selectedType = networkTypes.find((option) => option.id === typeId) ?? null;
  const requiresSpec = selectedType?.requiresSpec ?? false;
  const availableRegions = typeId ? (regionsByType[typeId] ?? []) : [];
  const availableIsps = typeId && regionId ? (ispsByTypeAndRegion[typeId]?.[regionId] ?? []) : [];
  const availableSpecs = requiresSpec && ispId ? (specsByIsp[ispId] ?? []) : [];
  const availableDurations = typeId ? (durationsByType[typeId] ?? []) : [];

  const selectedRegion = availableRegions.find((option) => option.id === regionId) ?? null;
  const selectedIsp = availableIsps.find((option) => option.id === ispId) ?? null;
  const selectedSpec = availableSpecs.find((option) => option.id === specId) ?? null;
  const selectedDuration = availableDurations.find((option) => option.id === durationId) ?? null;
  const canSelectDuration = Boolean(selectedIsp && (!requiresSpec || selectedSpec));
  const durationPrices = useMemo<Record<string, number | null>>(
    () => Object.fromEntries(
      availableDurations.map((duration) => [
        duration.id,
        duration.price ?? selectedSpec?.pricesByDuration[duration.id] ?? null,
      ]),
    ),
    [availableDurations, selectedSpec],
  );

  const summary = useMemo<SelectionSummary>(() => {
    const complete = Boolean(
      selectedType &&
      selectedRegion?.configured &&
      selectedIsp &&
      (!requiresSpec || selectedSpec) &&
      selectedDuration,
    );
    const total = complete && selectedDuration ? (durationPrices[selectedDuration.id] ?? null) : null;

    return {
      type: selectedType?.name ?? "—",
      region: selectedRegion?.name ?? "—",
      isp: selectedIsp?.name ?? "—",
      spec: requiresSpec ? (selectedSpec?.name ?? "—") : "不适用",
      duration: selectedDuration?.name ?? "—",
      traffic: selectedSpec?.traffic ?? selectedType?.traffic ?? "—",
      bandwidth: selectedType?.bandwidth ?? "—",
      ipType: selectedType?.ipType ?? "—",
      udp: selectedType?.udp ?? "—",
      dns: selectedType?.dns ?? "—",
      listPrice: null,
      total,
      complete,
    };
  }, [durationPrices, requiresSpec, selectedDuration, selectedIsp, selectedRegion, selectedSpec, selectedType]);

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

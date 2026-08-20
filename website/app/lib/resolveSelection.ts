import {
  durationsByType,
  ispsByTypeAndRegion,
  networkTypes,
  regionsByType,
  specsByIsp,
  type DurationOption,
  type IspOption,
  type NetworkTypeOption,
  type RegionOption,
  type SpecOption,
} from "./subscribeCatalog";

/* 一组待校验的 catalog 选择 ID（可能为空 / 非法 / 不完整）。 */
export type CatalogSelection = {
  typeId: string | null;
  regionId: string | null;
  ispId: string | null;
  specId: string | null;
  durationId: string | null;
};

/* 摘要视图模型：唯一真源在此，hook 与独立提交页共用。 */
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

export type ResolvedSelection = {
  selectedType: NetworkTypeOption | null;
  requiresSpec: boolean;
  availableRegions: RegionOption[];
  availableIsps: IspOption[];
  availableSpecs: SpecOption[];
  availableDurations: DurationOption[];
  selectedRegion: RegionOption | null;
  selectedIsp: IspOption | null;
  selectedSpec: SpecOption | null;
  selectedDuration: DurationOption | null;
  canSelectDuration: boolean;
  durationPrices: Record<string, number | null>;
  summary: SelectionSummary;
};

/* 按 catalog 依赖链解析并校验一组 ID：type → region(configured) → isp → spec → duration。
   任一环无法在 catalog 中命中即视为该环未选中；summary.complete 只有全链有效才为 true。
   价格一律由 catalog 重新推导，绝不信任外部传入的价格。 */
export function resolveSelection(selection: CatalogSelection): ResolvedSelection {
  const { typeId, regionId, ispId, specId, durationId } = selection;

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

  const durationPrices: Record<string, number | null> = Object.fromEntries(
    availableDurations.map((duration) => [
      duration.id,
      duration.price ?? selectedSpec?.pricesByDuration[duration.id] ?? null,
    ]),
  );

  const complete = Boolean(
    selectedType &&
    selectedRegion?.configured &&
    selectedIsp &&
    (!requiresSpec || selectedSpec) &&
    selectedDuration,
  );
  const total = complete && selectedDuration ? (durationPrices[selectedDuration.id] ?? null) : null;

  const summary: SelectionSummary = {
    type: selectedType?.name ?? "—",
    region: selectedRegion?.name ?? "—",
    isp: selectedIsp?.name ?? "—",
    spec: requiresSpec ? (selectedSpec?.name ?? "—") : (selectedType?.specLabel ?? "不适用"),
    duration: selectedDuration?.name ?? "—",
    traffic: selectedSpec?.traffic ?? selectedType?.traffic ?? "—",
    bandwidth: selectedSpec?.bandwidth ?? selectedType?.bandwidth ?? "—",
    ipType: selectedType?.ipType ?? "—",
    udp: selectedType?.udp ?? "—",
    dns: selectedType?.dns ?? "—",
    listPrice: null,
    total,
    complete,
  };

  return {
    selectedType,
    requiresSpec,
    availableRegions,
    availableIsps,
    availableSpecs,
    availableDurations,
    selectedRegion,
    selectedIsp,
    selectedSpec,
    selectedDuration,
    canSelectDuration,
    durationPrices,
    summary,
  };
}

/* 从 URL query 读取选择 ID；未知附加参数忽略。 */
export function parseSelectionParams(params: URLSearchParams): CatalogSelection {
  return {
    typeId: params.get("type"),
    regionId: params.get("region"),
    ispId: params.get("isp"),
    specId: params.get("spec"),
    durationId: params.get("duration"),
  };
}

/* 把选择序列化为 query：只放公开 catalog ID；非规格方案省略 spec；
   联系方式 / 场景 / 备注 / 价格永不进入 URL。 */
export function selectionToQuery(selection: CatalogSelection): string {
  const { requiresSpec } = resolveSelection(selection);
  const params = new URLSearchParams();
  if (selection.typeId) params.set("type", selection.typeId);
  if (selection.regionId) params.set("region", selection.regionId);
  if (selection.ispId) params.set("isp", selection.ispId);
  if (requiresSpec && selection.specId) params.set("spec", selection.specId);
  if (selection.durationId) params.set("duration", selection.durationId);
  return params.toString();
}

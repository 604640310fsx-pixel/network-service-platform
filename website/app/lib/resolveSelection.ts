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
import { planAvailabilityKey, type PlanAvailabilityIndex } from "./planAvailability";

/* 单个五元组相对服务端权威可售状态的判定结果。"unknown" 表示未提供 availability
   （例如仍在加载或请求失败）；此时价格必须保持待确认，不能回退静态 catalog。 */
export type DurationAvailabilityStatus = "unknown" | "available" | "sold_out" | "unavailable";

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
  availability: DurationAvailabilityStatus;
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
  durationAvailability: Record<string, DurationAvailabilityStatus>;
  summary: SelectionSummary;
};

/* 按 catalog 依赖链解析并校验一组 ID：type → region(configured) → isp → spec → duration。
   任一环无法在 catalog 中命中即视为该环未选中；summary.complete 只有全链有效才为 true。
   金额只来自服务端 availability 的精确五元组；availability 缺失、条目未命中、价格非法、
   已停售或售罄时一律不使用静态 catalog 价格，也绝不用旧价格支持下单。 */
export function resolveSelection(
  selection: CatalogSelection,
  availability?: PlanAvailabilityIndex,
): ResolvedSelection {
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

  const specIdForLookup = requiresSpec ? (selectedSpec?.id ?? null) : null;
  const canLookupAvailability = Boolean(availability && canSelectDuration && typeId && regionId && ispId);

  const durationPrices: Record<string, number | null> = {};
  const durationAvailability: Record<string, DurationAvailabilityStatus> = {};
  for (const duration of availableDurations) {
    if (!canLookupAvailability) {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "unknown";
      continue;
    }
    const plan =
      availability![planAvailabilityKey(typeId!, regionId!, ispId!, specIdForLookup, duration.id)];
    if (plan === undefined || !plan.isActive) {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "unavailable";
    } else if (plan.soldOut) {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "sold_out";
    } else if (Number.isSafeInteger(plan.priceFen) && plan.priceFen > 0) {
      durationPrices[duration.id] = plan.priceFen / 100;
      durationAvailability[duration.id] = "available";
    } else {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "unavailable";
    }
  }

  const complete = Boolean(
    selectedType &&
    selectedRegion?.configured &&
    selectedIsp &&
    (!requiresSpec || selectedSpec) &&
    selectedDuration,
  );
  const total = complete && selectedDuration ? (durationPrices[selectedDuration.id] ?? null) : null;
  const selectionAvailability: DurationAvailabilityStatus =
    complete && selectedDuration ? (durationAvailability[selectedDuration.id] ?? "unknown") : "unknown";

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
    availability: selectionAvailability,
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
    durationAvailability,
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

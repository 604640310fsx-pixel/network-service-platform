import {
  durationsByType,
  ispsByTypeAndRegion,
  LOCAL_ISP_BASE_LINE_ID,
  LOCAL_ISP_BASE_TRAFFIC_ID,
  networkTypes,
  packageLinesByTypeAndRegion,
  packageSpecsByTypeAndRegion,
  regionsByType,
  specsByIsp,
  residentialLines, residentialV2Specs, residentialHistoricalSpecs, RESIDENTIAL_DEFAULT_SPEC,
  type DurationOption,
  type IspOption,
  type LineOption,
  type NetworkTypeOption,
  type RegionOption,
  type SpecOption,
} from "./subscribeCatalog";
import { planAvailabilityKey, type PlanAvailabilityIndex } from "./planAvailability";
import type {ResidentialOptions} from "./residential-options";

/* 单个五元组相对服务端权威可售状态的判定结果。"unknown" 表示未提供 availability
   （调用方尚未拉取，或调用方本就不关心）——此时价格与既有目录逻辑完全一致，
   不视为不可售。*/
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
  residentialOptions?: ResidentialOptions;
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
  // 运营商由地区唯一确定（纯净原生独享 IP）：摘要 / 确认页不单列"运营商"，IP 类型行已说明原生IP / 广播IP。
  ispImplied: boolean;
};

/* 对 impliedIsp 类型，按地区补上（或纠正为）该地区唯一合法的 ispId；其余类型原样返回。
   报价、下单与 URL 始终带完整的五元组，不留空 ispId。 */
export function withImpliedIsp(selection: CatalogSelection): CatalogSelection {
  const type = networkTypes.find((option) => option.id === selection.typeId);
  if (!type?.impliedIsp || !selection.typeId || !selection.regionId) return selection;
  const isps = ispsByTypeAndRegion[selection.typeId]?.[selection.regionId] ?? [];
  return isps.length === 1 ? { ...selection, ispId: isps[0]!.id } : selection;
}

/* 本地ISP运营商 / 纯净原生独享 IP 的初始选择：默认路线（A 现有套餐，specId 为 null）/ B 普通路线 200G，月付。
   只在地区与运营商已经由用户（或 URL）确定且合法之后生效；不替用户挑地区或运营商。 */
const PACKAGE_DEFAULT_SPEC_ID: Record<string, string | null> = {
  residential: RESIDENTIAL_DEFAULT_SPEC,
  "local-isp": null,
  "pure-native-ip": "ordinary-200g",
};
const PACKAGE_DEFAULT_DURATION_ID = "month-1";

/* 对 A / B：地区 + 运营商合法时，保留仍合法的线路 × 流量与有效期，只把缺失或在该地区不合法的部分补成默认值；
   其余类型、或地区 / 运营商尚未确定时原样返回。 */
export function withPackageDefaults(selection: CatalogSelection): CatalogSelection {
  const { typeId } = selection;
  if (!typeId || !(typeId in PACKAGE_DEFAULT_SPEC_ID)) return selection;
  const resolved = resolveSelection(selection);
  if (!resolved.selectedRegion?.configured || !resolved.selectedIsp) return selection;
  const defaultSpecId = PACKAGE_DEFAULT_SPEC_ID[typeId]!;
  const specId = resolved.selectedSpec
    ? resolved.selectedSpec.id
    : defaultSpecId === null || resolved.availableSpecs.some((option) => option.id === defaultSpecId)
      ? defaultSpecId
      : null;
  const durationId = resolved.selectedDuration ? resolved.selectedDuration.id : PACKAGE_DEFAULT_DURATION_ID;
  return { ...selection, specId, durationId };
}

/** Call ONLY on a new /subscribe entry, never an order/payment/retry/renewal. */
export function normalizeResidentialNewPurchase(selection: CatalogSelection): { selection: CatalogSelection; reconfirm: boolean } {
  if (selection.typeId !== "residential") return { selection, reconfirm: false };
  const regionId = regionsByType.residential?.some(row => row.id === selection.regionId) ? selection.regionId : null;
  const ispId = regionId && ispsByTypeAndRegion.residential?.[regionId]?.some(row => row.id === selection.ispId) ? selection.ispId : null;
  const legacy = ["shared-5", "shared-3", "dedicated", ...residentialHistoricalSpecs.map(row=>row.id)].includes(selection.specId ?? "");
  const validSpec = residentialV2Specs.some(row => row.id === selection.specId);
  const specId = ispId ? !legacy && validSpec ? selection.specId : RESIDENTIAL_DEFAULT_SPEC : null;
  const durationId = ispId ? !legacy && durationsByType.residential?.some(row => row.id === selection.durationId) ? selection.durationId : "month-1" : null;
  return { selection: { typeId: "residential", regionId, ispId, specId, durationId }, reconfirm: legacy };
}

export type ResolvedSelection = {
  selectedType: NetworkTypeOption | null;
  requiresSpec: boolean;
  // 是否展示规格这一步：必选规格（真住宅宽带 / 纯净原生独享 IP），或该地区有可选线路 × 流量。
  hasSpecStep: boolean;
  availableRegions: RegionOption[];
  availableIsps: IspOption[];
  availableSpecs: SpecOption[];
  availableLines: LineOption[];
  availableDurations: DurationOption[];
  selectedRegion: RegionOption | null;
  selectedIsp: IspOption | null;
  selectedSpec: SpecOption | null;
  selectedLine: LineOption | null;
  selectedTrafficId: string | null;
  selectedDuration: DurationOption | null;
  canSelectDuration: boolean;
  durationPrices: Record<string, number | null>;
  durationAvailability: Record<string, DurationAvailabilityStatus>;
  summary: SelectionSummary;
};

/* 按 catalog 依赖链解析并校验一组 ID：type → region(configured) → isp → spec → duration。
   任一环无法在 catalog 中命中即视为该环未选中；summary.complete 只有全链有效才为 true。
   availability 缺省时价格保持待确认；传入服务端 availability index 后，
   每个 duration 的价格与可售状态由服务端权威数据决定——
   未命中或已停售/售罄一律不使用 catalog 价格，视为价格待确认，绝不用旧价格支持下单。 */
export function resolveSelection(
  selection: CatalogSelection,
  availability?: PlanAvailabilityIndex,
): ResolvedSelection {
  const { typeId, regionId, ispId, specId, durationId } = selection;

  const selectedType = networkTypes.find((option) => option.id === typeId) ?? null;
  const requiresSpec = selectedType?.requiresSpec ?? false;
  const availableRegions = typeId ? (regionsByType[typeId] ?? []) : [];
  const availableIsps = typeId && regionId ? (ispsByTypeAndRegion[typeId]?.[regionId] ?? []) : [];
  // 线路 × 流量选配按 type + region 定义（与 ISP 无关）；真住宅宽带规格仍按 ISP 定义。
  const legacyResidential = typeId === "residential" && ["shared-5", "shared-3", "dedicated"].includes(specId ?? "");
  const regionLines = typeId === "residential" && !legacyResidential ? residentialLines : typeId && regionId ? (packageLinesByTypeAndRegion[typeId]?.[regionId] ?? []) : [];
  const regionPackageSpecs = typeId && regionId ? packageSpecsByTypeAndRegion[typeId]?.[regionId] : undefined;
  const hasPackageOptions = regionLines.length > 0;
  const hasSpecStep = requiresSpec || hasPackageOptions;
  const availableSpecs = !ispId
    ? []
    : (typeId === "residential" && !legacyResidential ? residentialHistoricalSpecs.some(row=>row.id===specId)?residentialHistoricalSpecs:residentialV2Specs : regionPackageSpecs ?? (requiresSpec ? (specsByIsp[ispId] ?? []) : []));
  const availableLines = ispId ? regionLines : [];

  const selectedRegion = availableRegions.find((option) => option.id === regionId) ?? null;
  const selectedIsp = availableIsps.find((option) => option.id === ispId) ?? null;
  const selectedSpec = availableSpecs.find((option) => option.id === specId) ?? null;
  // 本地ISP运营商：specId 为 null 即现有套餐（普通线路 / 现有线路 + 200G）。
  // 有可选线路的地区里，非 null 且不在目录内的 specId 视为无效，不回落到现有套餐。
  const isBaseSelection = !requiresSpec && specId === null;
  const specSatisfied = requiresSpec
    ? selectedSpec !== null
    : selectedSpec !== null || isBaseSelection || !hasPackageOptions;
  const selectedLine = selectedSpec?.lineId
    ? (regionLines.find((line) => line.id === selectedSpec.lineId) ?? null)
    : hasPackageOptions && isBaseSelection
      ? (regionLines.find((line) => line.id === LOCAL_ISP_BASE_LINE_ID) ?? null)
      : null;
  const selectedTrafficId =
    selectedSpec?.trafficId ?? (hasPackageOptions && isBaseSelection ? LOCAL_ISP_BASE_TRAFFIC_ID : null);
  const typeDurations = typeId ? (durationsByType[typeId] ?? []) : [];
  // 选配项与现有套餐同样提供月付 / 半年 / 年付；周期价来自所选规格（或现有套餐的固定周期价）。
  const availableDurations = typeDurations;
  const selectedDuration = availableDurations.find((option) => option.id === durationId) ?? null;
  const canSelectDuration = Boolean(selectedIsp && specSatisfied);

  const specIdForLookup = selectedSpec?.id ?? null;
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
    if (plan === undefined || !plan.isActive || !Number.isSafeInteger(plan.priceFen) || plan.priceFen <= 0) {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "unavailable";
    } else if (plan.soldOut) {
      durationPrices[duration.id] = null;
      durationAvailability[duration.id] = "sold_out";
    } else {
      durationPrices[duration.id] = plan.priceFen / 100;
      durationAvailability[duration.id] = "available";
    }
  }

  const complete = Boolean(
    selectedType &&
    selectedRegion?.configured &&
    selectedIsp &&
    specSatisfied &&
    selectedDuration,
  );
  const total = complete && selectedDuration ? (durationPrices[selectedDuration.id] ?? null) : null;
  const selectionAvailability: DurationAvailabilityStatus =
    complete && selectedDuration ? (durationAvailability[selectedDuration.id] ?? "unknown") : "unknown";

  const summary: SelectionSummary = {
    ...(selectedDuration && availability?.[planAvailabilityKey(typeId!,regionId!,ispId!,specIdForLookup,selectedDuration.id)]?.residentialOptions
      ? { residentialOptions: availability[planAvailabilityKey(typeId!,regionId!,ispId!,specIdForLookup,selectedDuration.id)]!.residentialOptions } : {}),
    type: selectedType?.name ?? "—",
    region: selectedRegion?.name ?? "—",
    isp: selectedIsp?.name ?? "—",
    spec: selectedSpec
      ? selectedSpec.name
      : requiresSpec
        ? "—"
        : (selectedLine?.summaryLabel ?? selectedType?.specLabel ?? "不适用"),
    duration: selectedDuration?.name ?? "—",
    // 选配项未给带宽时显示"—"，不沿用现有套餐的 100M。
    traffic: selectedSpec ? (selectedSpec.traffic ?? "—") : (selectedType?.traffic ?? "—"),
    bandwidth: selectedSpec ? (selectedSpec.bandwidth ?? "—") : (selectedType?.bandwidth ?? "—"),
    ipType: selectedIsp?.ipType ?? selectedType?.ipType ?? "—",
    udp: selectedType?.udp ?? "—",
    dns: selectedType?.dns ?? "—",
    listPrice: null,
    total,
    complete,
    availability: selectionAvailability,
    ispImplied: Boolean(selectedType?.impliedIsp),
  };

  return {
    selectedType,
    requiresSpec,
    hasSpecStep,
    availableRegions,
    availableIsps,
    availableSpecs,
    availableLines,
    availableDurations,
    selectedRegion,
    selectedIsp,
    selectedSpec,
    selectedLine,
    selectedTrafficId,
    selectedDuration,
    canSelectDuration,
    durationPrices,
    durationAvailability,
    summary,
  };
}

/* 从 URL query 读取选择 ID；未知附加参数忽略。 */
export function parseSelectionParams(params: URLSearchParams): CatalogSelection {
  return withImpliedIsp({
    typeId: params.get("type"),
    regionId: params.get("region"),
    ispId: params.get("isp"),
    specId: params.get("spec"),
    durationId: params.get("duration"),
  });
}

/* 把选择序列化为 query：只放公开 catalog ID；目录内不存在的 spec（含非规格方案）省略；
   联系方式 / 场景 / 备注 / 价格永不进入 URL。 */
export function selectionToQuery(selection: CatalogSelection): string {
  const { selectedSpec } = resolveSelection(selection);
  const params = new URLSearchParams();
  if (selection.typeId) params.set("type", selection.typeId);
  if (selection.regionId) params.set("region", selection.regionId);
  if (selection.ispId) params.set("isp", selection.ispId);
  if (selectedSpec) params.set("spec", selectedSpec.id);
  if (selection.durationId) params.set("duration", selection.durationId);
  return params.toString();
}

// SUBSCRIBE-CATALOG-V1 — 已确认的产品目录；本文件价格为正式人民币应付价格。

export type NetworkTypeOption = {
  id: string;
  name: string;
  startingPrice: number | null;
  description: string;
  features: string[];
  requiresSpec: boolean;
  traffic: string | null;
  bandwidth: string | null;
  ipType: string | null;
  udp: string | null;
  dns: string | null;
  badge?: string;
  // 不需要选规格的网络类型（requiresSpec: false）本身只有单一档位，
  // 摘要面板用这个标签代替生硬的"不适用"，说明这一档实际是什么。
  specLabel?: string;
  // 每个地区只有唯一一个"运营商"项（纯净原生独享 IP 的原生IP / 广播IP）：选地区即自动带上该项，不单独设确认步骤。
  impliedIsp?: boolean;
};

export type RegionOption = {
  id: string;
  name: string;
  // 仅地区卡显示的名称（纯净原生独享 IP 不带"（原生IP）/（广播IP）"）；摘要等其余位置仍用 name。
  cardName?: string;
  flagClass: string;
  startingPrice?: number | null;
  badge?: string;
  configured: boolean;
};

export type IspOption = {
  id: string;
  name: string;
  description: string;
  routeInfo?: string;
  // 纯净原生独享 IP 用"IP 类型"占运营商这一环（原生IP / 广播IP），摘要的 IP 类型取这里。
  ipType?: string;
};

export type SpecOption = {
  id: string;
  name: string;
  monthlyPrice: number | null;
  pricesByDuration: Partial<Record<string, number>>;
  traffic: string | null;
  bandwidth: string | null;
  features: string[];
  description: string;
  badge?: string;
  // 线路 × 流量选配项（NSP-PACKAGE-COPY-20261101-01）才有以下字段；真住宅宽带规格没有。
  lineId?: string;
  trafficId?: string;
  // 本地ISP运营商选配项：批准加价表中该线路 × 流量档的月费加价（元/月），仅用于展示；最终价仍由服务端核定。
  surcharge?: number;
  deviceAllowance?: number | null;
};

export type LineOption = {
  id: string;
  name: string;
  description: string;
  notice?: string;
  // 仅展示：选中该线路的现有套餐（specId 为 null）时，摘要 / 确认页"规格"显示此文案，不影响订单快照或价格。
  summaryLabel?: string;
};

export type TrafficOption = {
  id: string;
  name: string;
};

export type DurationOption = {
  id: string;
  name: string;
  months: number;
  price: number | null;
  badge?: string;
};

// 展示顺序与标题（用户 2026-11-02 确认）：真住宅宽带 → 独享双ISP静态原生 → 本地住宅原生静态IP → 纯净静态独享IP。
// 展示顺序固定；各商品价格与默认选择按各自获准目录维护，订单快照由服务端保存。
export const networkTypes: NetworkTypeOption[] = [
  {
    id: "residential",
    name: "真住宅宽带",
    startingPrice: 89,
    description: "按国家、住宅 ISP 与共享规格配置",
    features: ["UDP", "IPv4 / IPv6", "DNS一致", "线路稳定", "低延迟", "电信 CN2 GIA", "联通 9929", "移动 CMIN2"],
    requiresSpec: true,
    traffic: null,
    bandwidth: null,
    ipType: "IPv4 / IPv6",
    udp: "完整支持",
    dns: "一致",
    badge: "推荐",
  },
  {
    id: "us-local-carrier",
    name: "独享双ISP静态原生",
    startingPrice: 49,
    description: "美国本地运营商网络方案",
    features: ["双 ISP 独享静态原生 IP", "美国直连优化路线", "200G / 500G 流量", "200M 带宽"],
    requiresSpec: false,
    traffic: "200G",
    bandwidth: "200M",
    // "独享"这个事实归到 specLabel；ipType 单独表示协议版本。
    // 原始的完整描述"双 ISP 独享静态原生 IP"仍保留在上面 features 里，没有丢。
    ipType: "IPv4",
    udp: "仅支持",
    dns: "支持",
    specLabel: "独享",
  },
  {
    id: "local-isp",
    name: "本地住宅原生静态IP",
    startingPrice: 79,
    description: "精品本地运营商网络",
    features: ["精品本地运营商网络", "原生静态住宅IP", "200G 流量", "100M 带宽"],
    requiresSpec: false,
    traffic: "200G",
    bandwidth: "100M",
    ipType: "IPv4",
    udp: "仅支持",
    dns: "支持",
    specLabel: "优享",
  },
  {
    id: "pure-native-ip",
    name: "纯净静态独享IP",
    startingPrice: 19,
    description: "纯净独享 · 支持 ChatGPT / Claude · 流媒体全解锁",
    features: ["200G / 500G / 1T 流量", "按月计费"],
    requiresSpec: true,
    traffic: null,
    bandwidth: null,
    ipType: null,
    udp: null,
    dns: null,
    impliedIsp: true,
  },
];

export const regionsByType: Record<string, RegionOption[]> = {
  "us-local-carrier": [
    { id: "us", name: "美国", flagClass: "us", startingPrice: 49, configured: true },
  ],
  "local-isp": [
    { id: "us", name: "美国", flagClass: "us", startingPrice: 79, configured: true },
    { id: "tw", name: "台湾", flagClass: "tw", startingPrice: 79, configured: true },
    { id: "jp", name: "日本", flagClass: "jp", startingPrice: 79, configured: true },
    { id: "my", name: "马来西亚", flagClass: "my", startingPrice: 79, configured: true },
    { id: "kr", name: "韩国", flagClass: "kr", startingPrice: 79, configured: true },
    { id: "sg", name: "新加坡", flagClass: "sg", startingPrice: 79, configured: true },
    { id: "gb", name: "英国", flagClass: "gb", startingPrice: 79, configured: true },
    { id: "fr", name: "法国", flagClass: "fr", startingPrice: 79, configured: true },
    { id: "vn", name: "越南", flagClass: "vn", startingPrice: 79, configured: true },
    { id: "br", name: "巴西", flagClass: "br", startingPrice: 79, configured: true },
    { id: "de", name: "德国", flagClass: "de", startingPrice: 79, configured: true },
    { id: "th", name: "泰国", flagClass: "th", startingPrice: 79, configured: true },
    { id: "id", name: "印度尼西亚", flagClass: "id", startingPrice: 79, configured: true },
  ],
  residential: [
    { id: "sg", name: "新加坡", flagClass: "sg", startingPrice: 149, configured: true },
    { id: "jp", name: "日本", flagClass: "jp", startingPrice: 139, configured: true },
    { id: "vn", name: "越南", flagClass: "vn", startingPrice: 89, configured: true },
    { id: "my", name: "马来西亚", flagClass: "my", startingPrice: 139, configured: true },
    { id: "kr", name: "韩国", flagClass: "kr", startingPrice: 118, configured: true },
    { id: "tw", name: "台湾", flagClass: "tw", startingPrice: 159, configured: true },
    { id: "us", name: "美国", flagClass: "us", startingPrice: 129, configured: true },
  ],
  "pure-native-ip": [
    { id: "us", name: "美国（原生IP）", cardName: "美国", flagClass: "us", startingPrice: 19, configured: true },
    { id: "tw", name: "台湾（广播IP）", cardName: "台湾", flagClass: "tw", startingPrice: 19, configured: true },
    { id: "jp", name: "日本（广播IP）", cardName: "日本", flagClass: "jp", startingPrice: 19, configured: true },
    { id: "sg", name: "新加坡（广播IP）", cardName: "新加坡", flagClass: "sg", startingPrice: 19, configured: true },
    { id: "my", name: "马来西亚（广播IP）", cardName: "马来西亚", flagClass: "my", startingPrice: 49, configured: true },
  ],
};

// 首页仍消费该只读地区视图；保留既有地区展示，不参与 Subscribe 选择流程或报价。
export const regions: RegionOption[] = [
  { id: "sg", name: "新加坡", flagClass: "sg", configured: true },
  { id: "jp", name: "日本", flagClass: "jp", configured: true },
  { id: "vn", name: "越南", flagClass: "vn", configured: true },
  { id: "my", name: "马来西亚", flagClass: "my", configured: false },
  { id: "kr", name: "韩国", flagClass: "kr", configured: true },
  { id: "tw", name: "台湾", flagClass: "tw", configured: false },
  { id: "us", name: "美国", flagClass: "us", configured: true },
  { id: "more", name: "更多国家", flagClass: "globe", configured: false },
];

export const ispsByTypeAndRegion: Record<string, Record<string, IspOption[]>> = {
  "us-local-carrier": {
    us: [
      { id: "ntt", name: "NTT", description: "美国本地运营商" },
      { id: "gtt", name: "GTT", description: "美国本地运营商" },
      { id: "cogent", name: "Cogent", description: "美国本地运营商" },
      { id: "charter", name: "Charter", description: "美国本地运营商" },
    ],
  },
  "local-isp": {
    us: [
      { id: "us-verizon", name: "Verizon", description: "美国本地 ISP" },
      { id: "us-att", name: "AT&T", description: "美国本地 ISP" },
      { id: "us-rcn", name: "RCN", description: "美国本地 ISP" },
      { id: "us-cox", name: "Cox", description: "美国本地 ISP" },
      { id: "us-frontier", name: "Frontier", description: "美国本地 ISP" },
      { id: "us-charter", name: "Charter", description: "美国本地 ISP" },
    ],
    tw: [
      { id: "tw-hinet", name: "HiNet", description: "台湾本地 ISP" },
      { id: "tw-hoshin", name: "Hoshin", description: "台湾本地 ISP" },
      { id: "tw-sonet", name: "So-net", description: "台湾本地 ISP" },
      { id: "tw-tbc", name: "TBC", description: "台湾本地 ISP" },
    ],
    jp: [
      { id: "jp-softbank", name: "SoftBank", description: "日本本地 ISP" },
      { id: "jp-ntt", name: "NTT", description: "日本本地 ISP" },
      { id: "jp-kddi", name: "KDDI", description: "日本本地 ISP" },
      { id: "jp-sony", name: "Sony Network Communications", description: "日本本地 ISP" },
      { id: "jp-biglobe", name: "BIGLOBE", description: "日本本地 ISP" },
    ],
    my: [
      { id: "my-tm", name: "TM", description: "马来西亚本地 ISP" },
      { id: "my-ttnet", name: "TTNET", description: "马来西亚本地 ISP" },
      { id: "my-maxis", name: "Maxis", description: "马来西亚本地 ISP" },
      { id: "my-umobile", name: "U-Mobile", description: "马来西亚本地 ISP" },
    ],
    kr: [{ id: "kr-koreatelecom", name: "Korea Telecom", description: "韩国本地 ISP" }],
    sg: [{ id: "sg-starhub", name: "Starhub Ltd", description: "新加坡本地 ISP" }],
    gb: [
      { id: "gb-bt", name: "British Telecommunications", description: "英国本地 ISP" },
      { id: "gb-glide", name: "Glide Student & Residential", description: "英国本地 ISP" },
    ],
    fr: [{ id: "fr-orange", name: "Orange", description: "法国本地 ISP" }],
    vn: [{ id: "vn-fpt", name: "FPT Telecom", description: "越南本地 ISP" }],
    br: [{ id: "br-atplus", name: "ATPlus Telecom", description: "巴西本地 ISP" }],
    de: [{ id: "de-telefonica", name: "Telefonica", description: "德国本地 ISP" }],
    th: [{ id: "th-awn", name: "Advanced Wireless Network", description: "泰国本地 ISP" }],
    id: [{ id: "id-telkom", name: "PT. Telekomunikasi", description: "印度尼西亚本地 ISP" }],
  },
  residential: {
    sg: [{ id: "sptel", name: "SPTEL PTE. LTD.", description: "新加坡住宅 ISP" }],
    jp: [{ id: "glbb-japan", name: "GLBB Japan KK", description: "日本住宅 ISP" }],
    vn: [{ id: "vnpt-corp", name: "VNPT Corp", description: "越南住宅 ISP" }],
    kr: [{ id: "sk-broadband", name: "SK Broadband Co Ltd", description: "韩国住宅 ISP" }],
    my: [{ id: "tm-technology", name: "TM Technology Services Sdn Bhd", description: "马来西亚住宅 ISP" }],
    tw: [
      { id: "hinet", name: "HiNet", description: "台湾住宅 ISP" },
      { id: "so-net", name: "So-net", description: "台湾住宅 ISP" },
    ],
    us: [
      { id: "cox", name: "Cox", description: "美国住宅 ISP" },
      { id: "rcn", name: "RCN", description: "美国住宅 ISP" },
      { id: "windstream", name: "Windstream", description: "美国住宅 ISP" },
      { id: "att", name: "AT&T", description: "美国住宅 ISP" },
      { id: "verizon", name: "Verizon", description: "美国住宅 ISP" },
      { id: "comcast", name: "Comcast", description: "美国住宅 ISP" },
    ],
  },
  "pure-native-ip": {
    us: [{ id: "native-ip", name: "原生IP", description: "美国（原生IP）", ipType: "原生IP" }],
    tw: [{ id: "broadcast-ip", name: "广播IP", description: "台湾（广播IP）", ipType: "广播IP" }],
    jp: [{ id: "broadcast-ip", name: "广播IP", description: "日本（广播IP）", ipType: "广播IP" }],
    sg: [{ id: "broadcast-ip", name: "广播IP", description: "新加坡（广播IP）", ipType: "广播IP" }],
    my: [{ id: "broadcast-ip", name: "广播IP", description: "马来西亚（广播IP）", ipType: "广播IP" }],
  },
};

// 周期价（用户 2026-11-01 确认，仅本地ISP运营商与纯净原生独享 IP）：周期总价 = 最终月价 × 月数 × 折扣，月付不变。
// 半年 × 6 × 0.85 = × 51/10，年付 × 12 × 0.74 = × 222/25。
// 美区本地运营商保持原固定价；真住宅宽带保持原折扣：3 个月 9 折、半年 8.5 折、年付 8 折。
// 用整数分数计算并四舍五入到整元，与 auth-service pricing.ts 的 periodPriceFen 逐值一致（避免浮点误差）。
type PeriodRatio = readonly [numerator: number, denominator: number];

const STANDARD_PERIOD_RATIOS: Record<string, PeriodRatio> = {
  "month-6": [51, 10],
  "month-12": [222, 25],
};

const RESIDENTIAL_PERIOD_RATIOS: Record<string, PeriodRatio> = {
  "month-3": [27, 10],
  "month-6": [51, 10],
  "month-12": [48, 5],
};

function periodPrice(monthlyPrice: number, [numerator, denominator]: PeriodRatio): number {
  return Math.floor((2 * monthlyPrice * numerator + denominator) / (2 * denominator));
}

function periodPrices(monthlyPrice: number, ratios: Record<string, PeriodRatio>): Partial<Record<string, number>> {
  const prices: Partial<Record<string, number>> = { "month-1": monthlyPrice };
  for (const [id, ratio] of Object.entries(ratios)) prices[id] = periodPrice(monthlyPrice, ratio);
  return prices;
}

function residentialPricesByDuration(monthlyPrice: number): Partial<Record<string, number>> {
  return periodPrices(monthlyPrice, RESIDENTIAL_PERIOD_RATIOS);
}

// 三档流量/带宽为真实住宅宽带套餐的统一规格（5人拼车 200G、3人拼车 300G、独享 1000G，
// 均为 100M 带宽），跨地区/ISP 一致，不随价格变化。
function createResidentialSpecs(prices: { shared5: number; shared3: number; dedicated: number }): SpecOption[] {
  return [
    // 展示名称只用该档的流量（用户 2026-11-02：不显示共享人数，也不显示共享 / 独享字样）；
    // 规格 id（shared-5 / shared-3 / dedicated）、价格、容量与权益均不变，展示名不代表接入方式变化。
    {
      id: "shared-5",
      name: "200G",
      monthlyPrice: prices.shared5,
      pricesByDuration: residentialPricesByDuration(prices.shared5),
      traffic: "200G",
      bandwidth: "100M",
      features: ["200G 流量", "100M 带宽"],
      description: "",
    },
    {
      id: "shared-3",
      name: "300G",
      monthlyPrice: prices.shared3,
      pricesByDuration: residentialPricesByDuration(prices.shared3),
      traffic: "300G",
      bandwidth: "100M",
      features: ["300G 流量", "100M 带宽"],
      description: "",
    },
    {
      id: "dedicated",
      name: "1000G",
      monthlyPrice: prices.dedicated,
      pricesByDuration: residentialPricesByDuration(prices.dedicated),
      traffic: "1000G",
      bandwidth: "100M",
      features: ["1000G 流量", "100M 带宽"],
      description: "",
    },
  ];
}

export const specsByIsp: Record<string, SpecOption[]> = {
  sptel: createResidentialSpecs({ shared5: 149, shared3: 219, dedicated: 599 }),
  "glbb-japan": createResidentialSpecs({ shared5: 139, shared3: 199, dedicated: 549 }),
  "vnpt-corp": createResidentialSpecs({ shared5: 89, shared3: 129, dedicated: 339 }),
  "sk-broadband": createResidentialSpecs({ shared5: 118, shared3: 179, dedicated: 459 }),
  "tm-technology": createResidentialSpecs({ shared5: 139, shared3: 199, dedicated: 549 }),
  hinet: createResidentialSpecs({ shared5: 159, shared3: 239, dedicated: 659 }),
  "so-net": createResidentialSpecs({ shared5: 159, shared3: 239, dedicated: 659 }),
  cox: createResidentialSpecs({ shared5: 129, shared3: 189, dedicated: 499 }),
  rcn: createResidentialSpecs({ shared5: 129, shared3: 189, dedicated: 499 }),
  windstream: createResidentialSpecs({ shared5: 129, shared3: 189, dedicated: 499 }),
  att: createResidentialSpecs({ shared5: 139, shared3: 199, dedicated: 549 }),
  verizon: createResidentialSpecs({ shared5: 139, shared3: 199, dedicated: 549 }),
  comcast: createResidentialSpecs({ shared5: 159, shared3: 239, dedicated: 659 }),
};

export const RESIDENTIAL_DEFAULT_SPEC = "res-v2-direct-200g";
export const residentialLines: LineOption[] = [
  { id: "direct", name: "默认直连（高峰期不稳定）", description: "" },
  { id: "optimized", name: "优化线路", description: "" },
  { id: "highspeed", name: "高速线路", description: "" },
  { id: "live", name: "直播专线", description: "" },
];
// Labels/allowed combinations only. No static amount is used for a new purchase.
const residentialNamesByLine: Record<string, readonly string[]> = {
  direct: ["默认直连 · 200G", "默认直连 · 300G", "默认直连 · 1T"],
  optimized: ["优化线路 · 200G", "优化线路 · 300G", "优化线路 · 1T"],
  highspeed: ["高速线路 · 200G", "高速线路 · 300G", "高速线路 · 1T"],
  live: ["直播专线 · 200G", "直播专线 · 300G", "直播专线 · 1T"],
};
export const residentialV2Specs: SpecOption[] = [
  ...["200g","300g","1t"].map((trafficId,index)=>({id:`res-v2-direct-${trafficId}`,name:residentialNamesByLine.direct![index]!,monthlyPrice:null,pricesByDuration:{},traffic:["200G","300G","1T"][index]!,bandwidth:"100M",features:[],description:"",lineId:"direct",trafficId,deviceAllowance:[3,5,10][index]!,surcharge:0})),
  ...residentialLines.slice(1).flatMap((line, lineIndex) => ["200g", "300g", "1t"].map((trafficId, index) => ({
    id: `res-v2-${line.id}-${trafficId}`, name: residentialNamesByLine[line.id]![index]!,
    monthlyPrice: null, pricesByDuration: {}, traffic: ["200G", "300G", "1T"][index]!, bandwidth: "100M", features: [], description: "",
    lineId: line.id, trafficId, deviceAllowance: [3, 5, 10][index]!, surcharge: [[10,12,30],[20,25,70],[30,35,100]][lineIndex]![index]!,
  }))),
];
// Read-only historical order labels; never offered as new-purchase choices.
export const residentialHistoricalSpecs: SpecOption[] = [
  {id:'res-v2-direct-default',name:'默认直连 · 300G',traffic:'300G',trafficId:'300g',lineId:'direct',surcharge:0,deviceAllowance:null,monthlyPrice:null,pricesByDuration:{},bandwidth:'100M',features:[],description:''},
  ...['direct','optimized','highspeed','live'].map((lineId,index)=>({id:`res-v2-${lineId}-500g`,name:['默认直连 · 500G','优化线路 · 500G','高速线路 · 500G','直播专线 · 500G'][index]!,traffic:'500G',trafficId:'500g',lineId,surcharge:[10,20,40,60][index]!,deviceAllowance:index===0?null:5,monthlyPrice:null,pricesByDuration:{},bandwidth:'100M',features:[],description:''})),
];
export const residentialTrafficOptions = [{id:'200g',name:'200G'},{id:'300g',name:'300G'},{id:'1t',name:'1T'}];

// ===== 线路 × 流量选配（NSP-PACKAGE-COPY-20261101-01，全部按月、人民币元/月） =====
// specId 编码为 `${lineId}-${trafficId}`，沿用既有五元组的 spec 字段，不新增下单字段。
// 选配价为最终月价；半年 / 年付按统一周期规则由月价计算（不提供 3 个月）。

export const trafficOptions: TrafficOption[] = [
  { id: "200g", name: "200G" },
  { id: "500g", name: "500G" },
  { id: "1t", name: "1T" },
];

// 独享双 ISP 新购月付四档：规格只承载选择身份与获准加价展示，结算仍以服务端 sellable_plans 为准。
const US_LOCAL_CARRIER_LINES: LineOption[] = [
  { id: "direct", name: "默认线路", description: "" },
  { id: "optimized", name: "优化线路", description: "" },
];
const US_LOCAL_CARRIER_SPECS: SpecOption[] = US_LOCAL_CARRIER_LINES.flatMap((line) =>
  (["200g", "500g"] as const).map((trafficId) => {
    const traffic = trafficId === "200g" ? "200G" : "500G";
    return {
      id: `${line.id}-${trafficId}`,
      name: `${line.name} · ${traffic}`,
      monthlyPrice: null,
      pricesByDuration: {},
      traffic,
      bandwidth: "200M",
      features: [`${traffic} 流量`, "200M 带宽"],
      description: "",
      lineId: line.id,
      trafficId,
      surcharge: line.id === "direct" ? 0 : trafficId === "200g" ? 10 : 20,
    };
  }),
);

type TrafficPrices = Partial<Record<string, number>>;

function trafficName(trafficId: string): string {
  return trafficOptions.find((option) => option.id === trafficId)?.name ?? trafficId;
}

function packagePeriodPrices(price: number | null): Partial<Record<string, number>> {
  return price === null ? {} : periodPrices(price, STANDARD_PERIOD_RATIOS);
}

function packageSpec(
  line: LineOption,
  trafficId: string,
  monthlyPrice: number | null,
  description: string,
  bandwidth: string | null = null,
): SpecOption {
  const traffic = trafficName(trafficId);
  return {
    id: `${line.id}-${trafficId}`,
    name: `${line.name} · ${traffic}`,
    monthlyPrice,
    pricesByDuration: packagePeriodPrices(monthlyPrice),
    traffic,
    bandwidth,
    features: bandwidth ? [`${traffic} 流量`, `${bandwidth} 带宽`] : [`${traffic} 流量`],
    description,
    lineId: line.id,
    trafficId,
  };
}

// --- 大类 A：本地ISP运营商 = 所选地区现有套餐月价 + 所选线路 × 流量档的月费加价 ---
// 加价已对应所选流量档，不另收流量档基础费。现有套餐月价为月付 ¥79（本地ISP运营商全部地区一致，
// 即下方 durationsByType["local-isp"] 的月付价）。"普通线路/现有线路 + 200G"就是现有套餐本身
// （specId 为 null），提供月付 / 半年 / 年付（周期价按统一规则）；只有美国普通线路另有 500G / 1T 加价，
// 其他地区的现有线路只有 200G。
export const LOCAL_ISP_BASE_LINE_ID = "ordinary";
export const LOCAL_ISP_BASE_TRAFFIC_ID = "200g";
const LOCAL_ISP_EXISTING_MONTHLY_PRICE = 79;

type LocalIspLineGroup = {
  baseLine: LineOption;
  // 普通线路 / 现有线路在 200G 之外的流量档加价（200G 即现有套餐本身，不在此列）。
  baseLineSurcharges?: TrafficPrices;
  surcharges: { line: LineOption; byTraffic: TrafficPrices; bandwidth?: string }[];
};

// 线路卡只放线路名与必要的流量 / 带宽限制；加价金额只在下方流量档显示，不在卡片重复说明。
const HALF_OPTIMIZED: LineOption = { id: "half", name: "半优化线路", description: "" };
const HIGH_SPEED: LineOption = { id: "high", name: "高速线路", description: "" };

const LOCAL_ISP_LINE_GROUPS: Record<string, LocalIspLineGroup> = {
  us: {
    baseLine: { id: LOCAL_ISP_BASE_LINE_ID, name: "默认路线", description: "", summaryLabel: "默认路线 · 200G" },
    baseLineSurcharges: { "500g": 10, "1t": 20 },
    surcharges: [
      { line: HALF_OPTIMIZED, byTraffic: { "200g": 10, "500g": 20, "1t": 30 } },
      { line: HIGH_SPEED, byTraffic: { "200g": 20, "500g": 40, "1t": 70 } },
      { line: { id: "live", name: "直播专线", description: "" }, byTraffic: { "200g": 30, "500g": 60, "1t": 100 } },
    ],
  },
  "southeast-asia": {
    baseLine: { id: LOCAL_ISP_BASE_LINE_ID, name: "默认路线", description: "", summaryLabel: "默认路线 · 200G" },
    surcharges: [
      { line: HALF_OPTIMIZED, byTraffic: { "200g": 10, "500g": 20, "1t": 30 } },
      { line: HIGH_SPEED, byTraffic: { "200g": 30, "500g": 60, "1t": 100 } },
      { line: { id: "live", name: "直播专线", description: "仅限 1T 档位，带宽 20Mbps" }, byTraffic: { "1t": 200 }, bandwidth: "20Mbps" },
    ],
  },
  "asia-europe-brazil": {
    baseLine: { id: LOCAL_ISP_BASE_LINE_ID, name: "默认路线", description: "", summaryLabel: "默认路线 · 200G" },
    surcharges: [
      { line: HALF_OPTIMIZED, byTraffic: { "200g": 10, "500g": 20, "1t": 30 } },
      { line: HIGH_SPEED, byTraffic: { "200g": 30, "500g": 60, "1t": 100 } },
      { line: { id: "live", name: "直播专线", description: "仅限 1T 档位，带宽 100Mbps" }, byTraffic: { "1t": 250 }, bandwidth: "100Mbps" },
    ],
  },
};

const LOCAL_ISP_GROUP_BY_REGION: Record<string, string> = {
  us: "us",
  sg: "southeast-asia",
  my: "southeast-asia",
  vn: "southeast-asia",
  id: "southeast-asia",
  th: "southeast-asia",
  tw: "asia-europe-brazil",
  jp: "asia-europe-brazil",
  fr: "asia-europe-brazil",
  de: "asia-europe-brazil",
  br: "asia-europe-brazil",
  gb: "asia-europe-brazil",
};

function localIspSpecs(group: LocalIspLineGroup): SpecOption[] {
  const specs: SpecOption[] = [];
  const lines = group.baseLineSurcharges
    ? [{ line: group.baseLine, byTraffic: group.baseLineSurcharges, bandwidth: undefined }, ...group.surcharges]
    : group.surcharges;
  for (const { line, byTraffic, bandwidth } of lines) {
    for (const { id: trafficId } of trafficOptions) {
      const surcharge = byTraffic[trafficId];
      if (surcharge === undefined) continue;
      const description = `现有月价 ¥${LOCAL_ISP_EXISTING_MONTHLY_PRICE} + ${trafficName(trafficId)} 线路加价 ¥${surcharge}/月`;
      specs.push({
        ...packageSpec(line, trafficId, LOCAL_ISP_EXISTING_MONTHLY_PRICE + surcharge, description, bandwidth ?? null),
        surcharge,
      });
    }
  }
  return specs;
}

// --- 大类 B：纯净原生独享 IP，表内金额即最终套餐月价，不叠加 A 类价格 ---
const PURE_NATIVE_LINES: Record<string, LineOption> = {
  ordinary: { id: "ordinary", name: "普通路线", description: "" },
  half: { id: "half", name: "半优化线路", description: "" },
  high: { id: "high", name: "高速线路", description: "" },
  "three-net": { id: "three-net", name: "三网专线", description: "" },
};

const PURE_NATIVE_PRICES: Record<string, Record<string, [number, number, number]>> = {
  us: { ordinary: [19, 29, 39], half: [29, 39, 59], high: [39, 59, 89], "three-net": [49, 79, 119] },
  tw: { ordinary: [19, 29, 39] },
  jp: { ordinary: [19, 29, 39], high: [79, 119, 209] },
  sg: { ordinary: [19, 29, 39], high: [89, 139, 229] },
  my: { ordinary: [49, 69, 119], high: [169, 289, 479] },
};

function pureNativeSpecs(prices: Record<string, [number, number, number]>): SpecOption[] {
  return Object.entries(prices).flatMap(([lineId, tiers]) =>
    trafficOptions.map((traffic, index) =>
      packageSpec(PURE_NATIVE_LINES[lineId]!, traffic.id, tiers[index]!, PURE_NATIVE_LINES[lineId]!.description),
    ),
  );
}

function mapRegions<T>(regionIds: string[], build: (regionId: string) => T): Record<string, T> {
  return Object.fromEntries(regionIds.map((regionId) => [regionId, build(regionId)]));
}

const localIspRegionIds = Object.keys(LOCAL_ISP_GROUP_BY_REGION);

export const packageLinesByTypeAndRegion: Record<string, Record<string, LineOption[]>> = {
  "us-local-carrier": { us: US_LOCAL_CARRIER_LINES },
  "local-isp": mapRegions(localIspRegionIds, (regionId) => {
    const group = LOCAL_ISP_LINE_GROUPS[LOCAL_ISP_GROUP_BY_REGION[regionId]!]!;
    return [group.baseLine, ...group.surcharges.map((item) => item.line)];
  }),
  "pure-native-ip": mapRegions(Object.keys(PURE_NATIVE_PRICES), (regionId) =>
    Object.keys(PURE_NATIVE_PRICES[regionId]!).map((lineId) => PURE_NATIVE_LINES[lineId]!),
  ),
};

export const packageSpecsByTypeAndRegion: Record<string, Record<string, SpecOption[]>> = {
  "us-local-carrier": { us: US_LOCAL_CARRIER_SPECS },
  "local-isp": mapRegions(localIspRegionIds, (regionId) =>
    localIspSpecs(LOCAL_ISP_LINE_GROUPS[LOCAL_ISP_GROUP_BY_REGION[regionId]!]!),
  ),
  "pure-native-ip": mapRegions(Object.keys(PURE_NATIVE_PRICES), (regionId) =>
    pureNativeSpecs(PURE_NATIVE_PRICES[regionId]!),
  ),
};

const residentialDurations: DurationOption[] = [
  { id: "month-1", name: "月付", months: 1, price: null },
  { id: "month-3", name: "3个月", months: 3, price: null, badge: "9折" },
  { id: "month-6", name: "半年", months: 6, price: null, badge: "8.5折" },
  { id: "month-12", name: "年付", months: 12, price: null, badge: "8折" },
];

/* 本地ISP运营商现有套餐与纯净原生独享 IP：price 为该周期总价；
   price 为 null 的周期（纯净原生独享 IP、选配项）取所选规格自身的周期价。 */
function standardDurations(monthlyPrice: number | null): DurationOption[] {
  const price = (id: string) => (monthlyPrice === null ? null : periodPrice(monthlyPrice, STANDARD_PERIOD_RATIOS[id]!));
  return [
    { id: "month-1", name: "月付", months: 1, price: monthlyPrice },
    { id: "month-6", name: "半年", months: 6, price: price("month-6"), badge: "8.5折" },
    { id: "month-12", name: "年付", months: 12, price: price("month-12"), badge: "7.4折" },
  ];
}

export const durationsByType: Record<string, DurationOption[]> = {
  // 旧 NULL 规格的固定周期价保留作历史目录事实；新购四档由服务端按 specId 报价，长期周期无已批准价格。
  "us-local-carrier": [
    { id: "month-1", name: "月付", months: 1, price: 59 },
    { id: "month-6", name: "半年", months: 6, price: 299 },
    { id: "month-12", name: "年付", months: 12, price: 499 },
  ],
  "local-isp": standardDurations(LOCAL_ISP_EXISTING_MONTHLY_PRICE),
  residential: residentialDurations,
  "pure-native-ip": standardDurations(null),
};

export const defaultCatalogSelection = {
  typeId: "residential",
  regionId: "vn",
  ispId: "vnpt-corp",
  specId: RESIDENTIAL_DEFAULT_SPEC,
  durationId: "month-1",
} as const;

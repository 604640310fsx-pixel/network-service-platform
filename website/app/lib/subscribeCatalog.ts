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
};

export type RegionOption = {
  id: string;
  name: string;
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
};

export type DurationOption = {
  id: string;
  name: string;
  months: number;
  price: number | null;
  badge?: string;
};

export const networkTypes: NetworkTypeOption[] = [
  {
    id: "us-local-carrier",
    name: "美区本地运营商",
    startingPrice: 59,
    description: "美国本地运营商网络方案",
    features: ["双 ISP 独享静态原生 IP", "美国直连优化路线", "500G 流量", "200M 带宽"],
    requiresSpec: false,
    traffic: "500G",
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
    name: "本地ISP运营商",
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
];

export const regionsByType: Record<string, RegionOption[]> = {
  "us-local-carrier": [
    { id: "us", name: "美国", flagClass: "us", startingPrice: 59, configured: true },
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
};

// 真住宅宽带的有效期折扣：1 个月原价，3 个月 9 折，6 个月 8.5 折，12 个月 8 折。
// 统一按月价 × 月数 × 折扣率四舍五入计算，不对 13 个 ISP × 3 档手工填 117 个数字。
const RESIDENTIAL_DURATION_DISCOUNTS: Record<string, number> = {
  "month-3": 0.9,
  "month-6": 0.85,
  "month-12": 0.8,
};

function residentialPricesByDuration(monthlyPrice: number): Partial<Record<string, number>> {
  const prices: Partial<Record<string, number>> = { "month-1": monthlyPrice };
  const months: Record<string, number> = { "month-3": 3, "month-6": 6, "month-12": 12 };
  for (const [id, discount] of Object.entries(RESIDENTIAL_DURATION_DISCOUNTS)) {
    prices[id] = Math.round(monthlyPrice * months[id] * discount);
  }
  return prices;
}

// 三档流量/带宽为真实住宅宽带套餐的统一规格（5人拼车 200G、3人拼车 300G、独享 1000G，
// 均为 100M 带宽），跨地区/ISP 一致，不随价格变化。
function createResidentialSpecs(prices: { shared5: number; shared3: number; dedicated: number }): SpecOption[] {
  return [
    {
      id: "shared-5",
      name: "5人",
      monthlyPrice: prices.shared5,
      pricesByDuration: residentialPricesByDuration(prices.shared5),
      traffic: "200G",
      bandwidth: "100M",
      features: ["200G 流量", "100M 带宽"],
      description: "5 人共享",
    },
    {
      id: "shared-3",
      name: "3人",
      monthlyPrice: prices.shared3,
      pricesByDuration: residentialPricesByDuration(prices.shared3),
      traffic: "300G",
      bandwidth: "100M",
      features: ["300G 流量", "100M 带宽"],
      description: "3 人共享",
      badge: "推荐",
    },
    {
      id: "dedicated",
      name: "独享",
      monthlyPrice: prices.dedicated,
      pricesByDuration: residentialPricesByDuration(prices.dedicated),
      traffic: "1000G",
      bandwidth: "100M",
      features: ["1000G 流量", "100M 带宽"],
      description: "独享接入",
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

const residentialDurations: DurationOption[] = [
  { id: "month-1", name: "月付", months: 1, price: null },
  { id: "month-3", name: "3个月", months: 3, price: null, badge: "9折" },
  { id: "month-6", name: "半年", months: 6, price: null, badge: "8.5折" },
  { id: "month-12", name: "年付", months: 12, price: null, badge: "8折" },
];

export const durationsByType: Record<string, DurationOption[]> = {
  "us-local-carrier": [
    { id: "month-1", name: "月付", months: 1, price: 59 },
    { id: "month-6", name: "半年", months: 6, price: 299 },
    { id: "month-12", name: "年付", months: 12, price: 499 },
  ],
  "local-isp": [
    { id: "month-1", name: "月付", months: 1, price: 79 },
    { id: "month-6", name: "半年", months: 6, price: 399 },
    { id: "month-12", name: "年付", months: 12, price: 699 },
  ],
  residential: residentialDurations,
};

export const defaultCatalogSelection = {
  typeId: "residential",
  regionId: "vn",
  ispId: "vnpt-corp",
  specId: "shared-3",
  durationId: "month-1",
} as const;

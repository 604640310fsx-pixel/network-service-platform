// SUBSCRIBE-CATALOG-V1 — 已确认的产品目录；正式价格仍待冻结。

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
    ipType: "双 ISP 独享静态原生 IP",
    udp: null,
    dns: null,
  },
  {
    id: "local-isp",
    name: "本地ISP运营商",
    startingPrice: 79,
    description: "精品本地运营商网络",
    features: ["精品本地运营商网络", "香港中转精品线路", "200G 流量", "100M 带宽"],
    requiresSpec: false,
    traffic: "200G",
    bandwidth: "100M",
    ipType: null,
    udp: null,
    dns: null,
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
    udp: "支持",
    dns: "一致",
    badge: "推荐",
  },
];

export const regionsByType: Record<string, RegionOption[]> = {
  "us-local-carrier": [
    { id: "us", name: "美国", flagClass: "us", startingPrice: 59, configured: true },
  ],
  "local-isp": [
    { id: "hk", name: "香港", flagClass: "hk", startingPrice: 79, configured: true },
  ],
  residential: [
    { id: "sg", name: "新加坡", flagClass: "sg", startingPrice: 149, configured: true },
    { id: "jp", name: "日本", flagClass: "jp", startingPrice: 139, configured: true },
    { id: "vn", name: "越南", flagClass: "vn", startingPrice: 89, configured: true },
    { id: "kr", name: "韩国", flagClass: "kr", startingPrice: 118, configured: true },
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
    hk: [
      { id: "hk-telecom", name: "电信", description: "香港中转精品线路", routeInfo: "电信 CN2" },
      { id: "hk-unicom", name: "联通", description: "香港中转精品线路", routeInfo: "联通 4837" },
      { id: "hk-mobile", name: "移动", description: "香港中转精品线路", routeInfo: "移动 CMI" },
    ],
  },
  residential: {
    sg: [{ id: "sptel", name: "SPTEL PTE. LTD.", description: "新加坡住宅 ISP" }],
    jp: [{ id: "glbb-japan", name: "GLBB Japan KK", description: "日本住宅 ISP" }],
    vn: [{ id: "vnpt-corp", name: "VNPT Corp", description: "越南住宅 ISP" }],
    kr: [{ id: "sk-broadband", name: "SK Broadband Co Ltd", description: "韩国住宅 ISP" }],
  },
};

function createResidentialSpecs(prices: { shared5: number; shared3: number; dedicated: number }): SpecOption[] {
  return [
    {
      id: "shared-5",
      name: "5人",
      monthlyPrice: prices.shared5,
      pricesByDuration: { "month-1": prices.shared5 },
      traffic: null,
      features: [],
      description: "5 人共享",
    },
    {
      id: "shared-3",
      name: "3人",
      monthlyPrice: prices.shared3,
      pricesByDuration: { "month-1": prices.shared3 },
      traffic: null,
      features: [],
      description: "3 人共享",
      badge: "推荐",
    },
    {
      id: "dedicated",
      name: "独享",
      monthlyPrice: prices.dedicated,
      pricesByDuration: { "month-1": prices.dedicated },
      traffic: null,
      features: [],
      description: "独享接入",
    },
  ];
}

export const specsByIsp: Record<string, SpecOption[]> = {
  sptel: createResidentialSpecs({ shared5: 149, shared3: 219, dedicated: 599 }),
  "glbb-japan": createResidentialSpecs({ shared5: 139, shared3: 199, dedicated: 549 }),
  "vnpt-corp": createResidentialSpecs({ shared5: 89, shared3: 129, dedicated: 339 }),
  "sk-broadband": createResidentialSpecs({ shared5: 118, shared3: 179, dedicated: 459 }),
};

const residentialDurations: DurationOption[] = [
  { id: "month-1", name: "月付", months: 1, price: null },
  { id: "month-6", name: "半年", months: 6, price: null },
  { id: "month-12", name: "年付", months: 12, price: null },
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

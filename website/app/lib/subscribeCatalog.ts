// PROTOTYPE DEMO DATA — 非正式产品数据，不可用于真实报价或订单。

export type NetworkTypeOption = {
  id: string;
  name: string;
  startingPrice: number;
  description: string;
  features: string[];
  badge?: string;
};

export type RegionOption = {
  id: string;
  name: string;
  flagClass: string;
  startingPrice?: number;
  badge?: string;
  configured: boolean;
};

export type IspOption = {
  id: string;
  name: string;
  description: string;
};

export type SpecOption = {
  id: string;
  name: string;
  monthlyPrice: number;
  traffic: string;
  features: string[];
  description: string;
  badge?: string;
};

export type DurationOption = {
  id: string;
  name: string;
  months: number;
  rate: number;
  badge?: string;
};

export const networkTypes: NetworkTypeOption[] = [
  {
    id: "ai-network",
    name: "AI 国际网络",
    startingPrice: 59,
    description: "面向 AI 与开发工具的原型套餐类型",
    features: ["固定独享 IP", "500G 月流量", "最高 200M 带宽", "多线路可选"],
  },
  {
    id: "local-isp",
    name: "本地 ISP",
    startingPrice: 79,
    description: "本地 ISP 网络的原型套餐类型",
    features: ["香港优化中转", "200G 月流量", "最高 100M 带宽", "按国家选择运营商"],
  },
  {
    id: "residential",
    name: "真住宅",
    startingPrice: 89,
    description: "真实家庭宽带的原型套餐类型",
    features: ["完整 UDP 支持", "DNS 一致", "稳定优选线路", "共享与独享可选"],
    badge: "推荐",
  },
];

export const regions: RegionOption[] = [
  { id: "sg", name: "新加坡", flagClass: "sg", startingPrice: 149, badge: "AI 首选", configured: false },
  { id: "jp", name: "日本", flagClass: "jp", startingPrice: 139, badge: "AI 推荐", configured: false },
  { id: "vn", name: "越南", flagClass: "vn", startingPrice: 89, badge: "性价比", configured: true },
  { id: "my", name: "马来西亚", flagClass: "my", startingPrice: 139, badge: "AI 推荐", configured: false },
  { id: "kr", name: "韩国", flagClass: "kr", startingPrice: 118, badge: "AI 推荐", configured: false },
  { id: "us", name: "美国", flagClass: "us", startingPrice: 129, badge: "AI / 社媒", configured: false },
  { id: "tw", name: "台湾", flagClass: "tw", startingPrice: 159, badge: "社媒推荐", configured: false },
  { id: "more", name: "更多国家", flagClass: "globe", configured: false },
];

export const ispsByRegion: Record<string, IspOption[]> = {
  vn: [{ id: "vnpt", name: "VNPT", description: "越南运营商 prototype 演示项" }],
};

export const specsByIsp: Record<string, SpecOption[]> = {
  vnpt: [
    {
      id: "shared-5",
      name: "5 人共享",
      monthlyPrice: 89,
      traffic: "200G",
      features: ["200G 流量", "最高 100M 带宽", "完整 UDP、DNS 一致"],
      description: "适合日常使用与基础测试",
    },
    {
      id: "shared-3",
      name: "3 人共享",
      monthlyPrice: 129,
      traffic: "300G",
      features: ["300G 流量", "最高 100M 带宽", "完整 UDP、DNS 一致", "包含环境检测"],
      description: "适合长期 AI 与社媒运营",
      badge: "推荐",
    },
    {
      id: "dedicated",
      name: "独享",
      monthlyPrice: 339,
      traffic: "1000G",
      features: ["1000G 流量", "最高 100M 带宽", "完整 UDP、DNS 一致", "一人独享、完整检测"],
      description: "适合重要账号与商业场景",
    },
  ],
};

export const durations: DurationOption[] = [
  { id: "month-1", name: "1 个月", months: 1, rate: 1 },
  { id: "month-3", name: "3 个月", months: 3, rate: 0.9535 },
  { id: "month-6", name: "6 个月", months: 6, rate: 0.9032 },
  { id: "month-12", name: "12 个月", months: 12, rate: 0.8391, badge: "最划算" },
];

export const defaultPrototypeSelection = {
  typeId: "residential",
  regionId: "vn",
  ispId: "vnpt",
  specId: "shared-3",
  durationId: "month-1",
} as const;

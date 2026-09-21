/* 隔离 fixture：仅供 ./ReferralPreview 与测试使用，正式组件与生产入口不得引用。
   演示数据 · 非报价；.invalid 为保留域名，不是真实推荐地址。
   数值与已验收的 v3 原型逐项一致（含 ¥999.99 / ¥1,000.00 边界与退款调整对账）。 */
import type { ReferralOrder, ReferralSnapshot } from "../referralModel";

export const FIXTURE_LINK = "https://example.invalid/r/DEMO-7K2Q";
export const FIXTURE_LONG_LINK = "https://example.invalid/r/DEMO-7K2Q-EXTREMELY-LONG-REFERRAL-SLUG-FOR-OVERFLOW-VERIFICATION-0001";

const NORMAL_ORDERS: readonly ReferralOrder[] = [
  { id: "DEMO-2609-01", month: "2026-09", customer: "客户 ••3F2A", product: "跨境专线 · 标准年付", type: "首购",
    amount: 99900, cap: 30, tierName: "核心伙伴", tierRate: 20, rate: 20, commission: 19980, status: "待结算", hint: "预估（月内）" },
  { id: "DEMO-2609-02", month: "2026-09", customer: "客户 ••8B14", product: "企业加速 · 季付续费", type: "续费",
    amount: 100000, cap: 15, tierName: "核心伙伴", tierRate: 20, rate: 15, commission: 15000, status: "待结算", hint: "预估（月内）",
    capped: true, note: "该商品佣金上限 15% 低于当期等级 20%，按商品上限计佣。" },
  { id: "DEMO-2609-03", month: "2026-09", customer: "客户 ••3F2A", product: "地区扩展包 · 加购", type: "加购",
    amount: 68100, cap: 30, tierName: "核心伙伴", tierRate: 20, rate: 20, commission: 13620, status: "待结算", hint: "预估（月内）" },
  { id: "DEMO-2608-01", month: "2026-08", customer: "客户 ••C7D9", product: "跨境专线 · 半年续费", type: "续费",
    amount: 56000, cap: 30, tierName: "进阶伙伴", tierRate: 15, rate: 15, commission: 8400, status: "待结算", hint: "月度核算完成，观察期中" },
  { id: "DEMO-2608-02", month: "2026-08", customer: "客户 ••8B14", product: "企业加速 · 季付", type: "首购",
    amount: 100000, cap: 30, tierName: "进阶伙伴", tierRate: 15, rate: 15, commission: 15000, status: "待结算", hint: "月度核算完成，观察期中" },
  { id: "DEMO-2607-01", month: "2026-07", customer: "客户 ••51E6", product: "跨境专线 · 年付", type: "首购",
    amount: 124000, cap: 30, tierName: "进阶伙伴", tierRate: 15, rate: 15, commission: 18600, status: "可提现", hint: "2026-07 期间已结算" },
  { id: "DEMO-2606-01", month: "2026-06", customer: "客户 ••C7D9", product: "基础加速 · 季付", type: "首购",
    amount: 80000, cap: 30, tierName: "入门伙伴", tierRate: 10, rate: 10, commission: 8000, status: "已提现", hint: "2026-06 期间已提现" },
];

const NORMAL: ReferralSnapshot = {
  month: "2026-09", sales: 268000, estimate: 48600,
  ledger: { withdrawable: 18600, pending: 23400, withdrawn: 8000 },
  orders: NORMAL_ORDERS,
  customers: [
    { id: "客户 ••3F2A", since: "2026-09", monthAmount: 168000, monthOrders: 2 },
    { id: "客户 ••8B14", since: "2026-08", monthAmount: 100000, monthOrders: 1 },
    { id: "客户 ••51E6", since: "2026-07", monthAmount: 0, monthOrders: 0 },
    { id: "客户 ••C7D9", since: "2026-06", monthAmount: 0, monthOrders: 0 },
  ],
  periods: [
    { month: "2026-09", sales: 268000, tierName: "核心伙伴", rate: 20, commission: 48600, status: "待结算", hint: "预估（月内），月末核算后进入待结算" },
    { month: "2026-08", sales: 156000, tierName: "进阶伙伴", rate: 15, commission: 23400, status: "待结算", hint: "月度核算完成，观察期中" },
    { month: "2026-07", sales: 124000, tierName: "进阶伙伴", rate: 15, commission: 18600, status: "可提现", hint: "已结算，可发起提现（功能待接入）" },
    { month: "2026-06", sales: 80000, tierName: "入门伙伴", rate: 10, commission: 8000, status: "已提现", hint: "已完成提现" },
  ],
};

function edge(settledJune: number, commissionJune: number, suffix: string): ReferralSnapshot {
  return {
    month: "2026-09", sales: 120000, estimate: 18000,
    ledger: { withdrawable: commissionJune + 33333, pending: 23400, withdrawn: 0 },
    orders: [
      { id: `DEMO-2609-${suffix}`, month: "2026-09", customer: "客户 ••C3D4", product: "地区扩展包 · 季付", type: "加购",
        amount: 120000, cap: 30, tierName: "进阶伙伴", tierRate: 15, rate: 15, commission: 18000, status: "待结算", hint: "预估（月内），不计入佣金余额" },
      { id: `DEMO-2608-${suffix}`, month: "2026-08", customer: "客户 ••C3D4", product: "跨境专线 · 半年付", type: "首购",
        amount: 156000, cap: 30, tierName: "进阶伙伴", tierRate: 15, rate: 15, commission: 23400, status: "待结算", hint: "观察期中，不计入佣金余额" },
      { id: `DEMO-2607-${suffix}`, month: "2026-07", customer: "客户 ••A1B2", product: "企业加速 · 年付续费（上限 15%）", type: "续费",
        amount: 222220, cap: 15, tierName: "核心伙伴", tierRate: 20, rate: 15, commission: 33333, status: "可提现", hint: "已结算，计入佣金余额",
        capped: true, note: "商品上限 15% 低于当期等级 20%，按商品上限计佣。" },
      { id: `DEMO-2606-${suffix}`, month: "2026-06", customer: "客户 ••A1B2", product: "跨境专线 · 年付", type: "首购",
        amount: settledJune, cap: 30, tierName: "核心伙伴", tierRate: 20, rate: 20, commission: commissionJune, status: "可提现", hint: "已结算，计入佣金余额" },
    ],
    customers: [
      { id: "客户 ••A1B2", since: "2026-06", monthAmount: 0, monthOrders: 0 },
      { id: "客户 ••C3D4", since: "2026-08", monthAmount: 120000, monthOrders: 1 },
    ],
    periods: [
      { month: "2026-09", sales: 120000, tierName: "进阶伙伴", rate: 15, commission: 18000, status: "待结算", hint: "预估（月内），不计入佣金余额" },
      { month: "2026-08", sales: 156000, tierName: "进阶伙伴", rate: 15, commission: 23400, status: "待结算", hint: "月度核算完成，观察期中；不计入佣金余额" },
      { month: "2026-07", sales: 222220, tierName: "核心伙伴", rate: 20, commission: 33333, status: "可提现", hint: "已结算，计入佣金余额" },
      { month: "2026-06", sales: settledJune, tierName: "核心伙伴", rate: 20, commission: commissionJune, status: "可提现", hint: "已结算，计入佣金余额" },
    ],
  };
}

const LONG_PRODUCT = "跨境网络优化 · 企业多地区多运营商组合专线加速（含扩展地区附加包、冗余线路与年度续费优惠）超长商品名称用于验证换行与截断行为";

export const REFERRAL_FIXTURES = {
  normal: NORMAL,
  zero: {
    month: "2026-09", sales: 0, estimate: 0, zero: true,
    ledger: { withdrawable: 0, pending: 0, withdrawn: 0 },
    orders: [], customers: [], periods: [],
  },
  long: {
    month: "2026-09", sales: 123456780, estimate: 37037034,
    ledger: { withdrawable: 0, pending: 0, withdrawn: 0 },
    orders: [
      { id: "DEMO-2609-LONG-0001", month: "2026-09", customer: "客户 ••D4A9（超长脱敏标识用于验证溢出与换行行为）",
        product: LONG_PRODUCT, type: "首购", amount: 123456780, cap: 30, tierName: "高级伙伴", tierRate: 30,
        rate: 30, commission: 37037034, status: "待结算", hint: "预估（月内）" },
    ],
    customers: [{ id: "客户 ••D4A9（超长脱敏标识用于验证溢出与换行行为）", since: "2026-09", monthAmount: 123456780, monthOrders: 1 }],
    periods: [{ month: "2026-09", sales: 123456780, tierName: "高级伙伴", rate: 30, commission: 37037034, status: "待结算", hint: "预估（月内）" }],
  },
  low: {
    month: "2026-09", sales: 3900, estimate: "unknown",
    ledger: { withdrawable: 0, pending: 0, withdrawn: 0 },
    orders: [
      { id: "DEMO-2609-11", month: "2026-09", customer: "客户 ••2A77", product: "基础加速 · 月付", type: "首购",
        amount: 3900, cap: 30, tierName: null, tierRate: null, rate: null, commission: null, status: "待结算", hint: "计佣方式待确认" },
    ],
    customers: [{ id: "客户 ••2A77", since: "2026-09", monthAmount: 3900, monthOrders: 1 }],
    periods: [{ month: "2026-09", sales: 3900, tierName: null, rate: null, commission: null, status: "待结算", hint: "低于 ¥59 的计佣方式待确认" }],
  },
  cap: {
    month: "2026-09", sales: 420000, estimate: 84000,
    ledger: { withdrawable: 0, pending: 0, withdrawn: 0 },
    orders: [
      { id: "DEMO-2609-21", month: "2026-09", customer: "客户 ••9C02", product: "企业加速 · 年付（上限 15%）", type: "首购",
        amount: 200000, cap: 15, tierName: "高级伙伴", tierRate: 30, rate: 15, commission: 30000, status: "待结算", hint: "预估（月内）",
        capped: true, note: "商品上限 15%，低于当期等级 30%。" },
      { id: "DEMO-2609-22", month: "2026-09", customer: "客户 ••4D58", product: "地区扩展包 · 年付（上限 20%）", type: "加购",
        amount: 120000, cap: 20, tierName: "高级伙伴", tierRate: 30, rate: 20, commission: 24000, status: "待结算", hint: "预估（月内）",
        capped: true, note: "商品上限 20%，低于当期等级 30%。" },
      { id: "DEMO-2609-23", month: "2026-09", customer: "客户 ••4D58", product: "跨境专线 · 年付（上限 30%）", type: "续费",
        amount: 100000, cap: 30, tierName: "高级伙伴", tierRate: 30, rate: 30, commission: 30000, status: "待结算", hint: "预估（月内）" },
    ],
    customers: [
      { id: "客户 ••9C02", since: "2026-09", monthAmount: 200000, monthOrders: 1 },
      { id: "客户 ••4D58", since: "2026-08", monthAmount: 220000, monthOrders: 2 },
    ],
    periods: [{ month: "2026-09", sales: 420000, tierName: "高级伙伴", rate: 30, commission: 84000, status: "待结算", hint: "预估（月内）" }],
  },
  refund: {
    month: "2026-09", sales: 385100, estimate: 77020,
    original: { sales: 405000, tierName: "高级伙伴", rate: 30, commission: 121500, refund: 19900, adjustment: 44480 },
    ledger: { withdrawable: 0, pending: 0, withdrawn: 0 },
    orders: [
      { id: "DEMO-2609-31", month: "2026-09", customer: "客户 ••6E11", product: "跨境专线 · 年付", type: "首购",
        amount: 199900, cap: 30, tierName: "高级伙伴", tierRate: 30, rate: 30, commission: 59970, status: "待结算", hint: "原记录保留",
        note: "本月等级已由高级伙伴 30% 调整为核心伙伴 20%，差额记录在调整记录中。" },
      { id: "DEMO-2609-32", month: "2026-09", customer: "客户 ••6E11", product: "企业加速 · 年付", type: "加购",
        amount: 185200, cap: 30, tierName: "高级伙伴", tierRate: 30, rate: 30, commission: 55560, status: "待结算", hint: "原记录保留",
        note: "本月等级已由高级伙伴 30% 调整为核心伙伴 20%，差额记录在调整记录中。" },
      { id: "DEMO-2609-33", month: "2026-09", customer: "客户 ••7B45", product: "地区扩展包 · 月付", type: "加购",
        amount: 19900, cap: 30, tierName: "高级伙伴", tierRate: 30, rate: 30, commission: 5970, status: "待结算", hint: "已退款，原记录保留", refunded: true },
      { id: "ADJ-2609-01", month: "2026-09", customer: "—", product: "退款调整 · 关联 DEMO-2609-33", type: "调整",
        amount: -19900, cap: null, tierName: "核心伙伴", tierRate: 20, rate: 20, commission: -44480, status: "调整记录", hint: "等级由 30% 重算为 20%",
        note: "退款 ¥199.00 冲减当月有效月销后，当月等级由高级伙伴 30% 降为核心伙伴 20%，全月佣金按新等级重算。",
        adjustment: { original: 121500, recalculated: 77020, refundedOwn: 5970, retiered: 38510 } },
    ],
    customers: [
      { id: "客户 ••6E11", since: "2026-09", monthAmount: 385100, monthOrders: 2 },
      { id: "客户 ••7B45", since: "2026-09", monthAmount: 0, monthOrders: 1, hint: "本月唯一订单已退款" },
    ],
    periods: [{ month: "2026-09", sales: 385100, tierName: "核心伙伴", rate: 20, commission: 77020, status: "待结算", hint: "退款调整后重算，预估（月内）" }],
  },
  edgeBelow: edge(333330, 66666, "91"),
  edgeMet: edge(333335, 66667, "92"),
} satisfies Record<string, ReferralSnapshot>;

export type ReferralFixtureKey = keyof typeof REFERRAL_FIXTURES;

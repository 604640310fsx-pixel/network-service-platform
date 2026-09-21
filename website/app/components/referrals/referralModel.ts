/* 推荐返佣中心 · 纯视图模型。
   只做展示计算，不发起请求、不持有真实数据。金额一律以「分」为整数。
   档位、费率与提现门槛为已批准展示契约，不在这里扩展商业规则。 */

export type Fen = number;

export type ReferralTier = {
  readonly key: "entry" | "advanced" | "core" | "senior";
  readonly name: string;
  readonly rate: number;
  readonly min: Fen;
  readonly max: Fen | null;
};

/** 已批准四档：按当月有效月销确定当月等级。 */
export const REFERRAL_TIERS: readonly ReferralTier[] = [
  { key: "entry", name: "入门伙伴", rate: 10, min: 5900, max: 99899 },
  { key: "advanced", name: "进阶伙伴", rate: 15, min: 99900, max: 199899 },
  { key: "core", name: "核心伙伴", rate: 20, min: 199900, max: 399899 },
  { key: "senior", name: "高级伙伴", rate: 30, min: 399900, max: null },
];

/** 低于该月销的计佣方式待确认（不按 0% 或 10% 处理，不是第五档）。 */
export const ENTRY_THRESHOLD_FEN: Fen = 5900;

/** 已冻结：已结算佣金余额达到 ¥1,000.00 才具备申请提现资格。 */
export const WITHDRAW_MIN_FEN: Fen = 100000;

export type ReferralOrderStatus = "待结算" | "可提现" | "已提现" | "调整记录";

export type ReferralOrder = {
  readonly id: string;
  readonly month: string;
  readonly customer: string;
  readonly product: string;
  readonly type: string;
  readonly amount: Fen;
  readonly cap: number | null;
  readonly tierName: string | null;
  readonly tierRate: number | null;
  readonly rate: number | null;
  readonly commission: Fen | null;
  readonly status: ReferralOrderStatus;
  readonly hint?: string;
  readonly note?: string;
  readonly capped?: boolean;
  readonly refunded?: boolean;
  /** 调整记录的计算说明（由数据方给出，不在前端推导）。 */
  readonly adjustment?: {
    readonly original: Fen;
    readonly recalculated: Fen;
    readonly refundedOwn: Fen;
    readonly retiered: Fen;
  };
};

export type ReferralCustomer = {
  readonly id: string;
  readonly since: string;
  readonly monthAmount: Fen;
  readonly monthOrders: number;
  readonly hint?: string;
};

export type ReferralPeriod = {
  readonly month: string;
  readonly sales: Fen;
  readonly tierName: string | null;
  readonly rate: number | null;
  readonly commission: Fen | null;
  readonly status: Exclude<ReferralOrderStatus, "调整记录">;
  readonly hint?: string;
};

export type ReferralLedger = {
  readonly withdrawable: Fen;
  readonly pending: Fen;
  readonly withdrawn: Fen;
};

export type ReferralSnapshot = {
  readonly month: string;
  readonly sales: Fen;
  readonly estimate: Fen | "unknown";
  readonly ledger: ReferralLedger;
  readonly orders: readonly ReferralOrder[];
  readonly customers: readonly ReferralCustomer[];
  readonly periods: readonly ReferralPeriod[];
  /** 本月是否为真实零值（已开通但无有效消费）。 */
  readonly zero?: boolean;
  /** 退款调整前的原始数据（仅在发生调整时由数据方提供）。 */
  readonly original?: {
    readonly sales: Fen;
    readonly tierName: string;
    readonly rate: number;
    readonly commission: Fen;
    readonly refund: Fen;
    readonly adjustment: Fen;
  };
};

/** 数据状态。生产默认为 pending（未接入），不渲染任何合成数值。 */
export type ReferralCenterData =
  | { readonly status: "pending" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly snapshot: ReferralSnapshot };

export type ReferralLinkState =
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly url: string };

/** 生产 / 默认状态：诚实的待接入占位，无合成数据。 */
export const REFERRAL_DATA_PENDING: ReferralCenterData = { status: "pending" };
export const REFERRAL_LINK_PENDING: ReferralLinkState = { status: "pending" };

/* ---------------- 格式化 ---------------- */

export function formatYuan(fen: Fen): string {
  const text = (Math.abs(fen) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (fen < 0 ? "−¥" : "¥") + text;
}

/** 门槛等整元金额的简写（¥1,999），不改变数值。 */
export function formatYuanWhole(fen: Fen): string {
  return "¥" + (fen / 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

export type MoneyParts = { readonly sign: string; readonly integer: string; readonly decimal: string };

export function moneyParts(fen: Fen): MoneyParts {
  const text = (Math.abs(fen) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const [integer, decimal] = text.split(".");
  return { sign: fen < 0 ? "−¥" : "¥", integer, decimal };
}

export function formatRate(rate: number | null): string {
  return rate === null ? "待确认" : `${rate}%`;
}

/* ---------------- 等级 ---------------- */

export function tierOf(sales: Fen | null): ReferralTier | null {
  if (sales === null || sales < ENTRY_THRESHOLD_FEN) return null;
  for (let index = REFERRAL_TIERS.length - 1; index >= 0; index -= 1) {
    if (sales >= REFERRAL_TIERS[index].min) return REFERRAL_TIERS[index];
  }
  return null;
}

export type LevelProgress = {
  readonly current: ReferralTier | null;
  readonly next: ReferralTier | null;
  /** 距下一档还差；已在最高档或未确定时为 null。 */
  readonly toNext: Fen | null;
  /** 每一段轨道的填充百分比（四段）。 */
  readonly fills: readonly number[];
};

export function levelProgress(sales: Fen | null): LevelProgress {
  const current = tierOf(sales);
  const currentIndex = current ? REFERRAL_TIERS.indexOf(current) : -1;
  const fills = REFERRAL_TIERS.map((tier, index) => {
    if (!current || sales === null) return 0;
    if (index < currentIndex) return 100;
    if (index > currentIndex) return 0;
    if (tier.max === null) return 100;
    return clampPercent(((sales - tier.min) / (tier.max - tier.min)) * 100);
  });
  const next = current && current.max !== null ? REFERRAL_TIERS[currentIndex + 1] : null;
  return {
    current,
    next,
    toNext: next && sales !== null ? next.min - sales : null,
    fills,
  };
}

/* ---------------- 提现资格 ---------------- */

export type WithdrawalGate = {
  readonly met: boolean;
  readonly shortfall: Fen;
  /** 资格进度条填充；未达门槛时视觉上限 99%，避免 ¥999.99 画成满格。 */
  readonly fill: number;
};

export function withdrawalGate(balance: Fen): WithdrawalGate {
  const met = balance >= WITHDRAW_MIN_FEN;
  const raw = clampPercent((balance / WITHDRAW_MIN_FEN) * 100);
  return {
    met,
    shortfall: met ? 0 : WITHDRAW_MIN_FEN - balance,
    fill: met ? raw : Math.min(raw, 99),
  };
}

/* ---------------- 月份筛选与分组 ---------------- */

export type MonthFilterModel = {
  /** 单一年份时显示「2026 年」，跨年时为 null（改用完整月份）。 */
  readonly yearLabel: string | null;
  readonly options: readonly { readonly value: string; readonly label: string; readonly ariaLabel: string }[];
};

export function monthFilterModel(months: readonly string[]): MonthFilterModel {
  const years = Array.from(new Set(months.map((month) => month.slice(0, 4))));
  const singleYear = years.length === 1;
  return {
    yearLabel: singleYear ? `${years[0]} 年` : null,
    options: months.map((month) => ({
      value: month,
      label: singleYear ? `${Number(month.slice(5, 7))}月` : month,
      ariaLabel: month,
    })),
  };
}

export function ordersMonths(orders: readonly ReferralOrder[]): string[] {
  const months: string[] = [];
  for (const order of orders) if (!months.includes(order.month)) months.push(order.month);
  return months;
}

export type OrderGroup = {
  readonly month: string;
  readonly orders: readonly ReferralOrder[];
  readonly amountTotal: Fen;
  /** 组内存在待确认佣金时为 null。 */
  readonly commissionTotal: Fen | null;
};

export const ALL_MONTHS = "ALL";

export function groupOrders(orders: readonly ReferralOrder[], filter: string): OrderGroup[] {
  const months = ordersMonths(orders);
  const shown = filter === ALL_MONTHS ? months : months.filter((month) => month === filter);
  return shown.map((month) => {
    const list = orders.filter((order) => order.month === month);
    const unknown = list.some((order) => order.commission === null);
    return {
      month,
      orders: list,
      amountTotal: list.reduce((sum, order) => sum + order.amount, 0),
      commissionTotal: unknown ? null : list.reduce((sum, order) => sum + (order.commission ?? 0), 0),
    };
  });
}

/** 对账：本月明细合计应与概览一致（用于隔离 fixture 的测试，不在界面上展示）。 */
export function reconcileMonth(snapshot: ReferralSnapshot): { readonly sales: boolean; readonly commission: boolean } {
  const [group] = groupOrders(snapshot.orders, snapshot.month);
  const sales = group ? group.amountTotal : 0;
  const commission = group ? group.commissionTotal : 0;
  return {
    sales: sales === snapshot.sales,
    commission: snapshot.estimate === "unknown" ? commission === null : commission === snapshot.estimate,
  };
}

/* ---------------- 复制推荐链接 ---------------- */

export type ClipboardWriter = { readonly writeText: (text: string) => Promise<void> };

export type CopyOutcome =
  | { readonly kind: "copied" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly reason: "unsupported" | "rejected" };

/** 只有剪贴板实际写入成功才返回 copied；不回退、不伪造成功。 */
export async function copyReferralLink(
  link: ReferralLinkState,
  clipboard: ClipboardWriter | null,
): Promise<CopyOutcome> {
  if (link.status !== "ready") return { kind: "missing" };
  if (!clipboard) return { kind: "failed", reason: "unsupported" };
  try {
    await clipboard.writeText(link.url);
    return { kind: "copied" };
  } catch {
    return { kind: "failed", reason: "rejected" };
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

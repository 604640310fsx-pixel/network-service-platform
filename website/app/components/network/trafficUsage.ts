import type { SubscriptionUsage } from "../../lib/subscription-info-api";

/* 订阅用量的派生值：已用 = upload + download；剩余 = total − 已用（不小于 0）。
   任何一项缺失都返回 null，由界面显示 —，不猜测。 */
export type UsageFacts = {
  readonly used: number | null;
  readonly remaining: number | null;
  readonly total: number | null;
  /** 0–1 share of total already used; null when unknown. */
  readonly ratio: number | null;
  readonly expireAt: Date | null;
};

export function usageFacts(usage: SubscriptionUsage): UsageFacts {
  const used = usage.upload === null && usage.download === null ? null : (usage.upload ?? 0) + (usage.download ?? 0);
  const total = usage.total === null || usage.total === 0 ? null : usage.total;
  const remaining = used === null || total === null ? null : Math.max(total - used, 0);
  const ratio = used === null || total === null ? null : Math.min(used / total, 1);
  return { used, remaining, total, ratio, expireAt: usage.expire === null ? null : new Date(usage.expire * 1000) };
}

/** Sum of the lines that report each figure, with how many lines contributed. */
export function aggregateUsage(list: readonly UsageFacts[]): { readonly used: number | null; readonly remaining: number | null; readonly lines: number } {
  const withUsed = list.filter((facts) => facts.used !== null);
  const withRemaining = list.filter((facts) => facts.remaining !== null);
  return {
    used: withUsed.length === 0 ? null : withUsed.reduce((sum, facts) => sum + (facts.used ?? 0), 0),
    remaining: withRemaining.length === 0 ? null : withRemaining.reduce((sum, facts) => sum + (facts.remaining ?? 0), 0),
    lines: withUsed.length,
  };
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Binary units (1 GB = 1024³ B), like subscription clients show them. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

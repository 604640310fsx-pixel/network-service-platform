/* 服务期限的展示与日期输入换算（UTC）。
   - 管理员用 <input type="date"> 选的是 UTC 日历日，存为当天 23:59:59.999Z（含当天）；
   - 买家看到的剩余天数向上取整；已到期的服务 / 赠送仍然显示，标为「已到期」而不是消失。 */

/** <input type="date"> value (UTC calendar day) → end of that UTC day; "" → null (long-term). */
export function endOfUtcDay(dateInput: string): string | null {
  if (dateInput === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) throw new RangeError("invalid date input");
  const value = `${dateInput}T23:59:59.999Z`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new RangeError("invalid date input");
  return value;
}

/** Stored instant → the UTC calendar day for <input type="date">; null → "". */
export function utcDateInput(instant: string | null): string {
  return instant === null ? "" : instant.slice(0, 10);
}

export type ServiceTerm =
  | { readonly kind: "long_term" }
  | { readonly kind: "expired" }
  | { readonly kind: "remaining"; readonly days: number };

/** Remaining whole days (rounded up) until endsAt; expired items stay visible as "expired". */
export function serviceTerm(endsAt: string | null, now: Date): ServiceTerm {
  if (endsAt === null) return { kind: "long_term" };
  const remaining = new Date(endsAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return { kind: "expired" };
  return { kind: "remaining", days: Math.ceil(remaining / 86_400_000) };
}

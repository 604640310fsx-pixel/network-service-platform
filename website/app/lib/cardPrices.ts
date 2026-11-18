/* 订阅页卡片上的“起”价 / 月价，只从服务端 /api/catalog/plans 的可用性索引计算；
   不读取 subscribeCatalog 的任何静态价格字段。只统计在售（isActive 且未售罄）的五元组。
   索引缺失（加载中 / 失败）或没有匹配项时返回 null，页面仍显示“价格待确认”。 */

import type { PlanAvailabilityIndex, PlanAvailabilityItem } from "./planAvailability";

export const MONTHLY_DURATION_ID = "month-1";

function purchasable(item: PlanAvailabilityItem): boolean {
  return item.isActive && !item.soldOut;
}

function minPriceFen(
  index: PlanAvailabilityIndex | null,
  matches: (item: PlanAvailabilityItem) => boolean,
): number | null {
  if (index === null) return null;
  let min: number | null = null;
  for (const item of Object.values(index)) {
    if (!purchasable(item) || !matches(item)) continue;
    if (min === null || item.priceFen < min) min = item.priceFen;
  }
  return min;
}

/** 套餐类型卡片：该类型所有在售五元组的最低价（分）。 */
export function typeFromPriceFen(index: PlanAvailabilityIndex | null, typeId: string): number | null {
  return minPriceFen(index, (item) => item.typeId === typeId);
}

/** 地区卡片：当前类型下该地区所有在售五元组的最低价（分）。 */
export function regionFromPriceFen(
  index: PlanAvailabilityIndex | null,
  typeId: string,
  regionId: string,
): number | null {
  return minPriceFen(index, (item) => item.typeId === typeId && item.regionId === regionId);
}

/** 规格卡片：精确 (类型, 地区, 运营商, 规格) 的月付价（分）；月付不存在或不可售时为 null。 */
export function specMonthlyPriceFen(
  index: PlanAvailabilityIndex | null,
  typeId: string,
  regionId: string | null,
  ispId: string | null,
  specId: string,
): number | null {
  if (regionId === null || ispId === null) return null;
  return minPriceFen(
    index,
    (item) =>
      item.typeId === typeId &&
      item.regionId === regionId &&
      item.ispId === ispId &&
      item.specId === specId &&
      item.durationId === MONTHLY_DURATION_ID,
  );
}

/** 与订单页 formatFen 一致：整元不带小数，否则保留两位。 */
export function formatCardYuan(priceFen: number): string {
  const amount = priceFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

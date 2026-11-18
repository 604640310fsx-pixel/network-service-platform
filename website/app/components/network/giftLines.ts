import type { MyGrantDeliveryLineItem, MyGrantItem } from "../../lib/payment-api";

export type GiftLineGroup = {
  readonly grantId: number;
  /** Gift plan name; null when the line's gift is not in the plan listing (shown by its id). */
  readonly label: string | null;
  readonly deliveryStatus: "pending_open" | "open";
  readonly lines: readonly MyGrantDeliveryLineItem[];
};

/* 节点页的赠送分组：每个有效赠送一组（待开通交付的组没有线路）；交付线路按 grantId 归组，
   找不到对应赠送的线路仍按自身 id 成组显示，不丢弃。只含线路名称，不含订阅地址。 */
export function groupGiftLines(
  grants: readonly MyGrantItem[],
  lines: readonly MyGrantDeliveryLineItem[] | null,
): GiftLineGroup[] {
  const byGrant = new Map<number, MyGrantDeliveryLineItem[]>();
  for (const line of lines ?? []) {
    const bucket = byGrant.get(line.grantId);
    if (bucket === undefined) byGrant.set(line.grantId, [line]);
    else bucket.push(line);
  }
  const sorted = (items: readonly MyGrantDeliveryLineItem[] | undefined) =>
    [...(items ?? [])].sort((left, right) => left.position - right.position);
  const groups: GiftLineGroup[] = grants.map((grant) => ({
    grantId: grant.grantId,
    label: grant.label,
    deliveryStatus: grant.deliveryStatus,
    lines: sorted(byGrant.get(grant.grantId)),
  }));
  const known = new Set(grants.map((grant) => grant.grantId));
  for (const [grantId, items] of byGrant) {
    if (!known.has(grantId)) groups.push({ grantId, label: null, deliveryStatus: "open", lines: sorted(items) });
  }
  return groups;
}

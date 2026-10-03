import type { MyGrantItem, MyServiceItem } from "../../lib/payment-api";

/* 仪表板概览把已购服务与有效赠送合并成一个「套餐」列表。计数口径：
   已购服务按 serviceStatus（open = 已开通，其余 = 待开通）；
   赠送按 deliveryStatus（open = 已交付，pending_open = 待开通交付）。 */
export type BuyerPlan =
  | { readonly kind: "purchase"; readonly key: string; readonly sortAt: string; readonly open: boolean; readonly service: MyServiceItem }
  | { readonly kind: "grant"; readonly key: string; readonly sortAt: string; readonly open: boolean; readonly grant: MyGrantItem };

/** Newest first: purchases by createdAt, gifts by startsAt (ties keep purchases first). */
export function combineBuyerPlans(services: readonly MyServiceItem[], grants: readonly MyGrantItem[]): BuyerPlan[] {
  const plans: BuyerPlan[] = [
    ...services.map((service): BuyerPlan => ({
      kind: "purchase",
      key: `purchase:${service.orderRef}`,
      sortAt: service.createdAt,
      open: service.serviceStatus === "open",
      service,
    })),
    ...grants.map((grant): BuyerPlan => ({
      kind: "grant",
      key: `grant:${grant.grantId}`,
      sortAt: grant.startsAt,
      open: grant.deliveryStatus === "open",
      grant,
    })),
  ];
  return plans
    .map((plan, index) => ({ plan, index }))
    .sort((left, right) => right.plan.sortAt.localeCompare(left.plan.sortAt) || left.index - right.index)
    .map(({ plan }) => plan);
}

export function buyerPlanCounts(plans: readonly BuyerPlan[]): { readonly total: number; readonly open: number; readonly pending: number } {
  const open = plans.filter((plan) => plan.open).length;
  return { total: plans.length, open, pending: plans.length - open };
}

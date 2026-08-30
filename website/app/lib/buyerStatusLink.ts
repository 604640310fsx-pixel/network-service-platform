export type BuyerStatusLine = {
  readonly monitorTargetKey: string | null;
};

export type BuyerStatusService = {
  readonly lines: readonly BuyerStatusLine[];
};

export function buyerStatusHref(target: string | null): string {
  return target === null ? "/status" : `/status?vps=${encodeURIComponent(target)}`;
}

/* 底部账户入口没有单独的线路上下文，因此按页面已经确定的服务与线路顺序，
   选取首个已绑定目标。逐条线路入口仍始终使用各自的 monitorTargetKey。 */
export function resolveBuyerStatusHref(
  services: readonly BuyerStatusService[],
): string {
  for (const service of services) {
    for (const line of service.lines) {
      if (line.monitorTargetKey !== null) return buyerStatusHref(line.monitorTargetKey);
    }
  }
  return "/status";
}

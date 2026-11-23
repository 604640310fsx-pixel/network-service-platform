import { ispsByTypeAndRegion } from "../../lib/subscribeCatalog";

/* 首页"推荐地区"卡片的落地链接：已配置地区进入真住宅宽带该地区的首个运营商，
   订阅页 seedSelection + withPackageDefaults 会补上默认线路 × 流量与月付，直接落在完整、带价的方案上；
   "更多地区"进入覆盖 13 国的本地ISP运营商（英国 BT）。只使用公开 catalog ID 与既有 query 格式。 */
export function homeRegionHref(regionId: string): string {
  if (regionId === "more") return "/subscribe?type=local-isp&region=gb&isp=gb-bt";
  const ispId = ispsByTypeAndRegion.residential?.[regionId]?.[0]?.id;
  if (!ispId) return "/subscribe";
  const params = new URLSearchParams({ type: "residential", region: regionId, isp: ispId });
  return `/subscribe?${params.toString()}`;
}

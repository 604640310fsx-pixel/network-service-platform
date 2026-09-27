/* 公开 /status 节点状态（纯函数，无 React / DOM 依赖，便于 node --test 直接验证）。

   数据来自 VITE_MONITOR_URL 所在监控 origin 的只读接口：
   GET /api/vps-targets 列出节点，GET /api/vps-status?target=<name> 返回单节点哪吒状态。
   解析只接受已知字段与类型；缺失或非法值显示为 —，不编造数值，也不回退演示数据。 */

export const NODE_STATUS_MAX_TARGETS = 64;

export type NodeStatusTarget = {
  readonly name: string;
  readonly displayName: string;
};

export type NodeStatusKind = "online" | "offline" | "stale" | "unavailable";

export type NodeStatusView = {
  readonly kind: NodeStatusKind;
  readonly updatedAt: string | null;
  readonly cpuPercent: number | null;
  readonly memoryPercent: number | null;
  readonly storagePercent: number | null;
  readonly uploadBytesPerSecond: number | null;
  readonly downloadBytesPerSecond: number | null;
  readonly uptimeSeconds: number | null;
};

export class NodeStatusResponseError extends Error {
  constructor() {
    super("node status response rejected");
    this.name = "NodeStatusResponseError";
  }
}

const UNAVAILABLE: NodeStatusView = Object.freeze({
  kind: "unavailable",
  updatedAt: null,
  cpuPercent: null,
  memoryPercent: null,
  storagePercent: null,
  uploadBytesPerSecond: null,
  downloadBytesPerSecond: null,
  uptimeSeconds: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < 1 || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

/** 监控 API 的 origin：只取 VITE_MONITOR_URL 的协议 + 主机，未配置或非法时返回 null。 */
export function nodeStatusApiOrigin(base: string | undefined, origin: string): string | null {
  const configured = base?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured, origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function nodeTargetsUrl(apiOrigin: string): string {
  return `${apiOrigin}/api/vps-targets`;
}

export function nodeStatusUrl(apiOrigin: string, targetName: string): string {
  return `${apiOrigin}/api/vps-status?target=${encodeURIComponent(targetName)}`;
}

/** 解析 /api/vps-targets：结构不符时整体拒绝；单条非法记录跳过；按名称去重。 */
export function parseNodeTargets(value: unknown): NodeStatusTarget[] {
  if (!isRecord(value) || !Array.isArray(value.targets)) throw new NodeStatusResponseError();
  const seen = new Set<string>();
  const targets: NodeStatusTarget[] = [];
  for (const entry of value.targets) {
    if (targets.length >= NODE_STATUS_MAX_TARGETS) break;
    if (!isRecord(entry)) continue;
    const name = cleanText(entry.target_name);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    targets.push(Object.freeze({ name, displayName: cleanText(entry.display_name) ?? name }));
  }
  return targets;
}

/** 解析 /api/vps-status：来源未就绪或缺少 item 时为 unavailable；
    不新鲜的数据标记为 stale，不当作当前在线。 */
export function parseNodeStatus(value: unknown): NodeStatusView {
  if (!isRecord(value) || value.source_status !== "ok" || !isRecord(value.item)) return UNAVAILABLE;
  const item = value.item;
  if (typeof item.online !== "boolean") return UNAVAILABLE;
  const kind: NodeStatusKind = value.fresh !== true ? "stale" : item.online ? "online" : "offline";
  return Object.freeze({
    kind,
    updatedAt: cleanText(value.updated_at),
    cpuPercent: finiteNumber(item.cpu_percent, 0, 100),
    memoryPercent: finiteNumber(item.memory_percent, 0, 100),
    storagePercent: finiteNumber(item.storage_percent, 0, 100),
    uploadBytesPerSecond: finiteNumber(item.upload_bytes_per_second, 0, Number.MAX_SAFE_INTEGER),
    downloadBytesPerSecond: finiteNumber(item.download_bytes_per_second, 0, Number.MAX_SAFE_INTEGER),
    uptimeSeconds: finiteNumber(item.uptime_seconds, 0, Number.MAX_SAFE_INTEGER),
  });
}

export function nodeStatusLabel(kind: NodeStatusKind): string {
  if (kind === "online") return "在线";
  if (kind === "offline") return "离线";
  if (kind === "stale") return "数据过期";
  return "暂无状态";
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return "—";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分`;
  return `${minutes} 分钟`;
}

export function formatUpdatedAt(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(parsed);
}

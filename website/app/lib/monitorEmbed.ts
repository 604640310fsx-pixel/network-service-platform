/* 监控 iframe 嵌入契约（纯函数，无 React / DOM 依赖，便于 node --test 直接验证）。

   两条职责：
   1. 由 VITE_MONITOR_URL 构造初始 iframe 地址，携带归一化后的 theme 与后端已校验的 vps
      target key，避免首屏主题闪烁，并保留线路进入时的目标选择。
   2. 提供运行时向 iframe 单向下发主题的窄类型消息与精确 targetOrigin，
      父页面永不使用 "*"，也永不读取子页面 DOM / 状态。 */

export type MonitorTheme = "dark" | "light";

/** 运行时主题消息类型：带版本号，子页面只接受这一精确字符串。 */
export const MONITOR_THEME_MESSAGE_TYPE = "nsp-monitor-theme:v1";

export type MonitorThemeMessage = {
  type: typeof MONITOR_THEME_MESSAGE_TYPE;
  theme: MonitorTheme;
};

const TARGET_MAX_LENGTH = 128;

/** 是否含 C0 控制字符（0x00-0x1f）或 DEL（0x7f）。用字符码扫描，避免在源码里写入控制字节。 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 归一化主题：只认 "light"，其余（含 null / 未知值）一律回落到 "dark"。 */
export function normalizeMonitorTheme(value: unknown): MonitorTheme {
  return value === "light" ? "light" : "dark";
}

/** 线路进入 /status?vps= 时携带的 target key 校验，与既有 3002 精确匹配约束一致：
    非 null、无首尾空白、长度 1..128、无控制字符。不合法返回 null（回落普通监控视图）。 */
export function normalizeMonitorTarget(value: string | null): string | null {
  if (
    value === null ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > TARGET_MAX_LENGTH ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

function toMonitorUrl(base: string | undefined, origin: string): URL | null {
  const configured = base?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured, origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** 构造初始 iframe src：写入归一化 theme，并按需保留 / 清除 vps。
    base 非法或未配置时返回 null，交由调用方渲染真实空状态。 */
export function buildMonitorEmbedUrl(
  base: string | undefined,
  options: { target: string | null; theme: MonitorTheme },
  origin: string,
): string | null {
  const url = toMonitorUrl(base, origin);
  if (!url) return null;
  if (options.target === null) url.searchParams.delete("vps");
  else url.searchParams.set("vps", options.target);
  url.searchParams.set("theme", normalizeMonitorTheme(options.theme));
  return url.toString();
}

/** postMessage 的精确 targetOrigin：VITE_MONITOR_URL 的 origin，永不返回 "*"。
    base 非法时返回 null，调用方据此不发送消息。 */
export function monitorPostTargetOrigin(base: string | undefined, origin: string): string | null {
  const url = toMonitorUrl(base, origin);
  return url ? url.origin : null;
}

/** 运行时主题消息负载：仅 type + theme，无任何客户 / 节点 / 监控 / 凭据 / 业务数据，
    也不含任何回读通道。 */
export function createMonitorThemeMessage(theme: MonitorTheme): MonitorThemeMessage {
  return { type: MONITOR_THEME_MESSAGE_TYPE, theme: normalizeMonitorTheme(theme) };
}

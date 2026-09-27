/* 公开监控 iframe 嵌入契约（纯函数，无 React / DOM 依赖，便于 node --test 直接验证）。

   VITE_MONITOR_URL 只能指向身份无关的公共三网摘要。本模块会清除已有查询参数，
   只重新写入展示参数（本地 fixture 标记除外），避免客户、节点或目标身份进入
   公共 iframe URL。
   运行时主题只经精确 targetOrigin 单向下发；父页面永不使用 "*"，也不回读
   子页面 DOM / 状态。登录用户的 VPS 状态属于独立 Auth 投影，不使用本模块。 */

export type MonitorTheme = "dark" | "light";

/** 运行时主题消息类型：带版本号，子页面只接受这一精确字符串。 */
export const MONITOR_THEME_MESSAGE_TYPE = "nsp-monitor-theme:v1";

export type MonitorThemeMessage = {
  type: typeof MONITOR_THEME_MESSAGE_TYPE;
  theme: MonitorTheme;
};

/** 归一化主题：只认 "light"，其余（含 null / 未知值）一律回落到 "dark"。 */
export function normalizeMonitorTheme(value: unknown): MonitorTheme {
  return value === "light" ? "light" : "dark";
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

/** 仅用于父页面标识本地 Fixture 预览。正式地址、其他 preview 值与非法配置
    均返回 false，避免把非 Fixture 数据误标为演示数据。 */
export function isMonitorFixturePreview(base: string | undefined, origin: string): boolean {
  const url = toMonitorUrl(base, origin);
  return url?.searchParams.get("preview") === "fixture";
}

/** 公开 /monitor 横幅状态：未配置或非法地址时为 "unconfigured"，页面不得显示
    LIVE / 实时同步；本地 Fixture 为 "fixture"；其余为已配置的公共网关 "embed"。
    "embed" 只表示已有经校验的公共地址，不证明网关可达或数据新鲜。 */
export type MonitorBannerMode = "unconfigured" | "fixture" | "embed";

export function monitorBannerMode(base: string | undefined, origin: string): MonitorBannerMode {
  const url = toMonitorUrl(base, origin);
  if (!url) return "unconfigured";
  return url.searchParams.get("preview") === "fixture" ? "fixture" : "embed";
}

/** 构造公共 iframe src：清除已有查询参数，只写入 theme 与受控 view；唯一保留项
    是值精确等于 fixture 的 preview 标记，用于本地演示数据保持可见标识。
    compact=true 使用侧栏 mini；embedded=true 使用去掉重复标题带的官网嵌入视图。
    两种视图互斥，冲突时 fail closed。base 非法或未配置时返回 null，由调用方
    渲染真实缺失态。 */
export function buildMonitorEmbedUrl(
  base: string | undefined,
  options: { theme: MonitorTheme; compact?: boolean; embedded?: boolean },
  origin: string,
): string | null {
  const url = toMonitorUrl(base, origin);
  if (!url || (options.compact && options.embedded)) return null;
  const fixturePreview = url.searchParams.get("preview") === "fixture";
  url.search = "";
  if (fixturePreview) url.searchParams.set("preview", "fixture");
  if (options.compact) url.searchParams.set("view", "mini");
  else if (options.embedded) url.searchParams.set("view", "embed");
  else url.searchParams.delete("view");
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

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import "./server-status.css";

const TARGET_MAX_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function normalizeRequestedTarget(value: string | null): string | null {
  if (
    value === null ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > TARGET_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function buildMonitorSource(base: string | undefined, target: string | null): string | null {
  const configured = base?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured, window.location.origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    if (target === null) url.searchParams.delete("vps");
    else url.searchParams.set("vps", target);
    return url.toString();
  } catch {
    return null;
  }
}

/* 登录后的 /status 直接展示既有 3002 监控页面。线路链接只携带后端已校验的
   target key；3002 再用自己的实时目标清单做精确匹配，无法匹配时回落到普通监控
   视图，不根据买家线路名称推测主机、IP 或节点。 */
export function BuyerServerStatusPage() {
  const [searchParams] = useSearchParams();
  const requestedTarget = normalizeRequestedTarget(searchParams.get("vps"));
  const monitorSource = useMemo(
    () => buildMonitorSource(import.meta.env.VITE_MONITOR_URL, requestedTarget),
    [requestedTarget],
  );

  return (
    <main className="cc-status-page">
      {monitorSource === null ? (
        <div className="cc-status-empty" role="status" aria-live="polite">
          <strong>服务器状态地址未配置</strong>
          <p>配置已批准的 3002 监控地址后，此处将显示对应 VPS 的服务器状态。</p>
        </div>
      ) : (
        <iframe
          className="cc-status-frame"
          src={monitorSource}
          title="VPS 服务器状态"
          allow="fullscreen"
          referrerPolicy="same-origin"
        />
      )}
    </main>
  );
}

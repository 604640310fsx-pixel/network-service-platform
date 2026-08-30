import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useCustomerShellTheme } from "../customer/CustomerCenterShell";
import {
  buildMonitorEmbedUrl,
  createMonitorThemeMessage,
  monitorPostTargetOrigin,
  normalizeMonitorTarget,
} from "../../lib/monitorEmbed";
import "./server-status.css";

/* 登录后的 /status 直接展示既有 3002 监控页面。线路链接只携带后端已校验的
   target key；3002 再用自己的实时目标清单做精确匹配，无法匹配时回落到普通监控
   视图，不根据买家线路名称推测主机、IP 或节点。

   主题：初始 src 携带归一化 theme 避免首屏闪烁；主题切换只通过精确 targetOrigin
   的单向 postMessage 下发，iframe 不重新导航，也不丢失已选 VPS / 时间范围 / 交互态。
   父页面永不读取 iframe 内部 DOM 或状态。 */
export function BuyerServerStatusPage() {
  const [searchParams] = useSearchParams();
  const theme = useCustomerShellTheme();
  const requestedTarget = normalizeMonitorTarget(searchParams.get("vps"));
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const base = import.meta.env.VITE_MONITOR_URL;
  // src 不把 theme 作为依赖，因此单纯切换主题不会重载 iframe；但若用户随后切换
  // vps，新的 iframe URL 会携带当时的实时主题，避免新页面先闪回旧主题。
  const currentThemeRef = useRef(theme);
  currentThemeRef.current = theme;
  const monitorSource = useMemo(
    () =>
      buildMonitorEmbedUrl(base, { target: requestedTarget, theme: currentThemeRef.current }, window.location.origin),
    [base, requestedTarget],
  );
  const targetOrigin = useMemo(() => monitorPostTargetOrigin(base, window.location.origin), [base]);

  const postTheme = useCallback(
    (next: typeof theme) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || !targetOrigin) return;
      frameWindow.postMessage(createMonitorThemeMessage(next), targetOrigin);
    },
    [targetOrigin],
  );

  // 主题切换时向已加载的 iframe 单向下发；首次运行时 iframe 可能尚未就绪，
  // 由 onLoad 再补发一次，确保加载完成后主题一致。
  useEffect(() => {
    postTheme(theme);
  }, [theme, postTheme]);

  return (
    <main className="cc-status-page">
      {monitorSource === null ? (
        <div className="cc-status-empty" role="status" aria-live="polite">
          <strong>服务器状态地址未配置</strong>
          <p>配置已批准的 3002 监控地址后，此处将显示对应 VPS 的服务器状态。</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          className="cc-status-frame"
          src={monitorSource}
          title="VPS 服务器状态"
          allow="fullscreen"
          referrerPolicy="same-origin"
          onLoad={() => postTheme(theme)}
        />
      )}
    </main>
  );
}

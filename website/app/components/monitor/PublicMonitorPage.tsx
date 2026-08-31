import { useCallback, useEffect, useMemo, useRef } from "react";
import { useThemePreference } from "../../lib/theme";
import { WorkbenchBanner } from "../WorkbenchBanner";
import { SiteHeader } from "../home/SiteHeader";
import {
  buildMonitorEmbedUrl,
  createMonitorThemeMessage,
  monitorPostTargetOrigin,
} from "../../lib/monitorEmbed";
import "../home/home.css";
import "./public-monitor.css";

/* 公开 /monitor：官网统一风格的公共实时监控页（游客与登录用户看到同一页面）。
   复用官网 SiteHeader 与既有主题偏好，不使用客户中心 Sidebar / Topbar；专用监控页
   不重复展示大页脚，把剩余视口完整留给监控内容。
   监控主体继续用现有 VITE_MONITOR_URL iframe，不重写 monitoring、不新增 API、
   不编造 SLA / 在线率 / 节点数量等数字；未配置时显示真实空状态。

   主题：初始 src 携带归一化 theme 避免闪烁；官网主题切换只经精确 targetOrigin 的
   单向 postMessage 下发，iframe 不重新导航，也不丢失监控内部交互态。 */
export function PublicMonitorPage() {
  const { theme, toggleTheme } = useThemePreference();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const base = import.meta.env.VITE_MONITOR_URL;
  // 初始主题只取一次：src 不随主题变化，主题切换不触发 iframe 重载。
  const initialThemeRef = useRef(theme);
  const monitorSource = useMemo(
    () => buildMonitorEmbedUrl(base, { target: null, theme: initialThemeRef.current }, window.location.origin),
    [base],
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

  useEffect(() => {
    postTheme(theme);
  }, [theme, postTheme]);

  return (
    <div className="cc-shell cc-home pm-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main className="pm-main">
        <section className="pm-head">
          <div className="pm-head-layout">
            <WorkbenchBanner
              kicker="实时观测"
              title="实时网络监控"
              description="查看当前三网线路与网络运行状态"
              statusLabel="实时数据同步"
              badge="LIVE · 15S"
            />
          </div>
        </section>

        <section className="pm-monitor">
          {monitorSource ? (
            <iframe
              ref={iframeRef}
              className="pm-frame"
              src={monitorSource}
              title="广州三网实时监控"
              allow="fullscreen"
              onLoad={() => postTheme(theme)}
            />
          ) : (
            <div className="pm-empty" role="status" aria-live="polite">
              <strong>监控地址未配置</strong>
              <p>监控地址尚未配置，配置后此处将显示实时网络监控。</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

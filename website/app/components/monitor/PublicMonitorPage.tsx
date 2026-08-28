import { useThemePreference } from "../../lib/theme";
import { SiteHeader } from "../home/SiteHeader";
import { SiteFooter } from "../home/SiteFooter";
import "../home/home.css";
import "./public-monitor.css";

/* 公开 /monitor：官网统一风格的公共实时监控页（游客与登录用户看到同一页面）。
   复用官网 SiteHeader / SiteFooter 与既有主题偏好，不使用客户中心 Sidebar / Topbar。
   监控主体继续用现有 VITE_MONITOR_URL iframe，不重写 monitoring、不新增 API、
   不编造 SLA / 在线率 / 节点数量等数字；未配置时显示真实空状态。 */
export function PublicMonitorPage() {
  const { theme, toggleTheme } = useThemePreference();
  const monitorUrl = import.meta.env.VITE_MONITOR_URL?.trim();

  return (
    <div className="cc-shell cc-home pm-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main className="pm-main">
        <section className="pm-head">
          <div className="home-wrap">
            <span className="pm-eyebrow">实时观测</span>
            <h1>实时网络监控</h1>
            <p>查看当前三网线路与网络运行状态</p>
          </div>
        </section>

        <section className="pm-monitor">
          <div className="home-wrap pm-monitor-wrap">
            {monitorUrl ? (
              <iframe
                className="pm-frame"
                src={monitorUrl}
                title="广州三网实时监控"
                allow="fullscreen"
              />
            ) : (
              <div className="pm-empty" role="status" aria-live="polite">
                <strong>监控地址未配置</strong>
                <p>监控地址尚未配置，配置后此处将显示实时网络监控。</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

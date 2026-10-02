import { useCallback, useEffect, useMemo, useRef } from "react";
import { useI18n, useT } from "../../lib/i18n";
import { useThemePreference, type ThemePreference } from "../../lib/theme";
import { WorkbenchBanner, workbenchBannerLayoutClass } from "../WorkbenchBanner";
import { SiteHeader } from "../home/SiteHeader";
import { useCustomerShellTheme } from "../customer/CustomerCenterShell";
import {
  buildMonitorEmbedUrl,
  createMonitorLangMessage,
  createMonitorThemeMessage,
  monitorBannerMode,
  monitorPostTargetOrigin,
  type MonitorBannerMode,
} from "../../lib/monitorEmbed";
import "../home/home.css";
import "../status/server-status.css";
import "./public-monitor.css";

/* 横幅文案按真实配置状态选择。本页没有网关健康或数据新鲜度证明，因此任何
   模式都不显示 LIVE / 实时同步；统一复用既有 is-fixture 的非绿色状态点，
   避免把“地址已配置”读成在线。 */
const BANNER_STYLE: Record<MonitorBannerMode, { badge: string; className?: string }> = {
  unconfigured: { badge: "NOT CONFIGURED", className: "is-fixture" },
  fixture: { badge: "FIXTURE · 15S", className: "is-fixture" },
  embed: { badge: "CONFIGURED", className: "is-fixture" },
};

/* 公开 /monitor：官网统一风格的公共实时监控页（游客与登录用户看到同一页面）。
   复用官网 SiteHeader 与既有主题偏好，不使用客户中心 Sidebar / Topbar；专用监控页
   不重复展示大页脚，把剩余视口完整留给监控内容。
   监控主体使用 VITE_MONITOR_URL 指向的身份无关公共网关，不重写数据、不新增 API、
   不编造 SLA / 在线率 / 节点数量等数字；未配置时显示真实空状态。embed 视图
   隐藏子页面重复标题，只保留官网 WorkbenchBanner。

   主题：初始 src 携带归一化 theme 避免闪烁；官网主题切换只经精确 targetOrigin 的
   单向 postMessage 下发，iframe 不重新导航，也不丢失监控内部交互态。 */
export function PublicMonitorPage() {
  const { theme, toggleTheme } = useThemePreference();
  const base = import.meta.env.VITE_MONITOR_URL;
  const bannerMode = useMemo(() => monitorBannerMode(base, window.location.origin), [base]);
  const copy = useT().monitor;
  const banner = { ...BANNER_STYLE[bannerMode], ...copy.banner[bannerMode] };

  return (
    <div className="cc-shell cc-home pm-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main className="pm-main">
        <section className="pm-head">
          <div className={workbenchBannerLayoutClass}>
            <WorkbenchBanner
              kicker="REAL-TIME OBSERVABILITY"
              title={copy.title}
              description={banner.description}
              statusLabel={banner.statusLabel}
              badge={banner.badge}
              className={banner.className}
            />
          </div>
        </section>

        <PublicMonitorEmbed theme={theme} />
      </main>
    </div>
  );
}

/* 已登录客户在客户中心壳层内访问 /status：同一公开运营方监控嵌入，
   主题随壳层 topbar 切换；不新增数据源、客户字段或账户投影。 */
export function CustomerShellMonitor() {
  const theme = useCustomerShellTheme();
  return <PublicMonitorEmbed theme={theme} />;
}

/* 公开监控 iframe 主体：/monitor、匿名 /status 与客户中心 /status 共用。 */
export function PublicMonitorEmbed({ theme }: { theme: ThemePreference }) {
  const copy = useT().monitor;
  const { lang } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const base = import.meta.env.VITE_MONITOR_URL;
  // 初始主题只取一次：src 不随主题变化，主题切换不触发 iframe 重载。
  const initialThemeRef = useRef(theme);
  const initialLangRef = useRef(lang);
  const monitorSource = useMemo(
    () => buildMonitorEmbedUrl(base, { theme: initialThemeRef.current, lang: initialLangRef.current, embedded: true }, window.location.origin),
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

  // 语言与主题同一通道：初始值写入 src，之后切换只发消息，不重载 iframe。
  const postLang = useCallback(
    (next: typeof lang) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || !targetOrigin) return;
      frameWindow.postMessage(createMonitorLangMessage(next), targetOrigin);
    },
    [targetOrigin],
  );

  useEffect(() => {
    postLang(lang);
  }, [lang, postLang]);

  return (
    <section className="pm-monitor">
      {monitorSource ? (
        <iframe
          ref={iframeRef}
          className="pm-frame"
          src={monitorSource}
          title={copy.frameTitle}
          allow="fullscreen"
          referrerPolicy="same-origin"
          onLoad={() => {
            postTheme(theme);
            postLang(lang);
          }}
        />
      ) : (
        <div className="pm-empty" role="status" aria-live="polite">
          <strong>{copy.emptyTitle}</strong>
          <p>{copy.emptyBody}</p>
        </div>
      )}
    </section>
  );
}

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useThemePreference } from "../../lib/theme";
import "./customer-center.css";

type DrawerKind = "navigation" | "order";
type DrawerContextValue = {
  activeDrawer: DrawerKind | null;
  openDrawer: (kind: DrawerKind, trigger: HTMLElement) => void;
  closeDrawer: () => void;
};

const CustomerDrawerContext = createContext<DrawerContextValue | null>(null);
// 已迁移到客户中心视觉的路由；其余菜单继续走 disabled / 待接入策略。
const migratedPaths = new Set<string>(["/subscribe", "/dashboard", "/services", "/network", "/monitor", "/orders"]);

export function useCustomerDrawer() {
  const value = useContext(CustomerDrawerContext);
  if (!value) throw new Error("useCustomerDrawer must be used inside CustomerCenterShell");
  return value;
}

const navigation = [
  { group: "概览", items: [["/status", "服务器状态"], ["/dashboard", "仪表板"]] },
  { group: "订阅管理", items: [["/subscribe", "套餐订阅"], ["/services", "当前套餐"], ["/network", "节点与流量"], ["/orders", "订单"]] },
  { group: "支持与帮助", items: [["/tickets", "工单"], ["/docs", "使用文档"]] },
  { group: "账户设置", items: [["/profile", "个人中心"], ["/invites", "邀请中心"], ["/referrals", "邀请/推广"]] },
] as const;

function NavIcon({ href }: { href: string }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "aria-hidden": true } as const;
  switch (href) {
    case "/status": return <svg {...common}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
    case "/dashboard": return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 12l4-3" /></svg>;
    case "/subscribe": return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M8 15h4" /></svg>;
    case "/services": return <svg {...common}><path d="M4 7h16M4 12h10M4 17h13" /></svg>;
    case "/network": return <svg {...common}><circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="18" r="2.4" /><circle cx="19" cy="18" r="2.4" /><path d="M12 7.4v4.2M10 13l-3.6 3M14 13l3.6 3" /></svg>;
    case "/orders": return <svg {...common}><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v6h6M9 14h6M9 17h4" /></svg>;
    case "/tickets": return <svg {...common}><path d="M21 12a9 9 0 1 1-3.2-6.9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01" /></svg>;
    case "/docs": return <svg {...common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13z" /><path d="M8 8h7M8 12h7" /></svg>;
    case "/profile": return <svg {...common}><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
    case "/invites": return <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M18 8v6M15 11h6" /></svg>;
    default: return <svg {...common}><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><rect x="2.5" y="7" width="19" height="5" rx="1" /><path d="M12 7v13M12 7S10.5 3 8 3.6 8 7 12 7zM12 7s1.5-4 4-3.4S16 7 12 7z" /></svg>;
  }
}

export function CustomerCenterShell({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: string;
  description: string;
}) {
  const { theme, toggleTheme } = useThemePreference();
  const [activeDrawer, setActiveDrawer] = useState<DrawerKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function openDrawer(kind: DrawerKind, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setActiveDrawer(kind);
  }

  function closeDrawer() {
    setActiveDrawer(null);
  }

  useEffect(() => {
    const root = rootRef.current;
    const topbar = topbarRef.current;
    if (!root || !topbar) return;

    const syncTopbarHeight = () => root.style.setProperty("--cc-top-height", `${topbar.offsetHeight}px`);
    syncTopbarHeight();
    window.addEventListener("resize", syncTopbarHeight);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncTopbarHeight);
    observer?.observe(topbar);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncTopbarHeight);
    };
  }, []);

  useEffect(() => {
    if (!activeDrawer) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const drawer = rootRef.current?.querySelector<HTMLElement>(`[data-cc-drawer="${activeDrawer}"]`);
    requestAnimationFrame(() => drawer?.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeDrawer]);

  return (
    <CustomerDrawerContext.Provider value={{ activeDrawer, openDrawer, closeDrawer }}>
      <div className="cc-shell" data-theme={theme} ref={rootRef}>
        <aside
          className={`cc-sidebar ${activeDrawer === "navigation" ? "is-open" : ""}`}
          data-cc-drawer="navigation"
          role={activeDrawer === "navigation" ? "dialog" : undefined}
          aria-modal={activeDrawer === "navigation" ? true : undefined}
          aria-label="客户中心导航"
        >
          <div className="cc-brand" aria-label="Drink Life">
            <span className="cc-brand-mark" aria-hidden="true" />
            <button type="button" className="cc-sidebar-close" onClick={closeDrawer} aria-label="关闭导航"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18M3 12h18M3 18h18" /></svg></button>
          </div>
          <nav className="cc-navigation" aria-label="客户中心">
            {navigation.map((group) => (
              <div className="cc-nav-group" key={group.group}>
                <p>{group.group}</p>
                {group.items.map(([href, label]) => migratedPaths.has(href) ? (
                  <NavLink key={href} to={href} onClick={closeDrawer} className={({ isActive }) => isActive ? "is-active" : ""}>
                    <NavIcon href={href} />{label}
                  </NavLink>
                ) : (
                  <button key={href} type="button" className="cc-nav-pending" aria-disabled="true" disabled title={`${label}待接入`}>
                    <NavIcon href={href} />{label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <section className="cc-monitor-card" aria-label="网络状态监控">
            <header><b>网络状态监控</b></header>
            <strong className="cc-monitor-status">实时监控已上线</strong>
            <p>查看三网线路与实时网络运行状态</p>
            <NavLink to="/monitor" className="cc-monitor-link" onClick={closeDrawer}>查看实时监控</NavLink>
          </section>
        </aside>

        <div className="cc-main">
          <header className="cc-topbar" ref={topbarRef}>
            <button
              type="button"
              className="cc-icon-button cc-menu-button"
              aria-label="打开导航"
              aria-expanded={activeDrawer === "navigation"}
              onClick={(event) => openDrawer("navigation", event.currentTarget)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <div className="cc-page-title"><h1>{title}</h1><p>{description}</p></div>
            <div className="cc-top-actions">
              <button
                type="button"
                className="cc-icon-button"
                aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                aria-pressed={theme === "light"}
                onClick={toggleTheme}
              >
                {theme === "dark" ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                )}
              </button>
              <span className="cc-balance-placeholder">余额 <b>—</b></span>
              <span className="cc-user-placeholder" aria-label="用户中心尚未接入"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg><span>用户中心</span></span>
            </div>
          </header>
          {children}
        </div>

        {activeDrawer && <button type="button" className={`cc-scrim ${activeDrawer === "navigation" ? "is-navigation" : ""}`} onClick={closeDrawer} aria-label="关闭抽屉" />}
      </div>
    </CustomerDrawerContext.Provider>
  );
}

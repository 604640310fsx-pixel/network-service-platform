import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import type { ThemePreference } from "../../lib/theme";

/* 官网公开 Header。不使用客户中心左侧 sidebar。
   导航只对仓库中真实存在且可呈现的路由开放跳转：
   /（首页）、/subscribe（网络方案）与 /monitor（服务状态）。"诊断服务"当前没有
   对应页面，呈现为不可点击的待接入项，不做成点击后假装可用。 */

type NavEntry =
  | { kind: "link"; label: string; to: string }
  | { kind: "pending"; label: string; title: string };

const navEntries: NavEntry[] = [
  { kind: "link", label: "首页", to: "/" },
  { kind: "link", label: "网络方案", to: "/subscribe" },
  { kind: "pending", label: "诊断服务", title: "诊断服务页面待接入" },
  { kind: "link", label: "服务状态", to: "/monitor" },
];

export function SiteHeader({
  theme,
  onToggleTheme,
}: {
  theme: ThemePreference;
  onToggleTheme: () => void;
}) {
  const { status } = useAuth();
  const [stuck, setStuck] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 已登录时入口指向客户中心，未登录（含会话检查中）指向登录页。
  const authenticated = status === "authenticated";
  const accountHref = authenticated ? "/dashboard" : "/login";
  const accountLabel = authenticated ? "客户中心" : "登录";

  return (
    <>
      <header className={`home-header${stuck ? " is-stuck" : ""}`}>
        <div className="home-wrap home-header-inner">
          <Link to="/" className="home-brand" onClick={() => setMenuOpen(false)} aria-label="Drink Life">
            <span className="home-brand-mark" aria-hidden="true" />
          </Link>

          <nav className="home-nav" aria-label="主导航">
            {navEntries.map((entry) =>
              entry.kind === "link" ? (
                <Link
                  key={entry.label}
                  to={entry.to}
                  className={entry.to === "/" ? "is-active" : undefined}
                  aria-current={entry.to === "/" ? "page" : undefined}
                >
                  {entry.label}
                </Link>
              ) : (
                <button key={entry.label} type="button" className="is-pending" disabled aria-disabled="true" title={entry.title}>
                  {entry.label}
                </button>
              ),
            )}
          </nav>

          <div className="home-header-actions">
            <button
              type="button"
              className="home-icon-button"
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              aria-pressed={theme === "light"}
              onClick={onToggleTheme}
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              )}
            </button>

            <Link to={accountHref} className="home-header-cta">{accountLabel}</Link>

            <button
              type="button"
              className="home-icon-button home-menu-button"
              aria-label={menuOpen ? "关闭导航" : "打开导航"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
              )}
            </button>
          </div>
        </div>

        <div className={`home-mobile-nav${menuOpen ? " is-open" : ""}`}>
          <div>
            {navEntries.map((entry) =>
              entry.kind === "link" ? (
                <Link key={entry.label} to={entry.to} onClick={() => setMenuOpen(false)}>
                  {entry.label}
                </Link>
              ) : (
                <button key={entry.label} type="button" className="is-pending" disabled aria-disabled="true">
                  {entry.label}
                </button>
              ),
            )}
            <Link to={accountHref} className="home-mobile-login" onClick={() => setMenuOpen(false)}>
              {accountLabel}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

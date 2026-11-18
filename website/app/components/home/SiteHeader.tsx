import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import type { ThemePreference } from "../../lib/theme";
import { LanguageToggle } from "../common/LanguageToggle";

/* 官网公开 Header。不使用客户中心左侧 sidebar。
   只开放仓库中真实存在且可呈现的公开页面。 */

const navEntries = [
  { key: "home", to: "/" },
  { key: "plans", to: "/subscribe" },
  { key: "diagnosis", to: "/diagnosis" },
  { key: "status", to: "/monitor" },
] as const;

export type MobileMenuKeyAction =
  | { kind: "close" }
  | { kind: "focus"; index: number }
  | null;

export function resolveMobileMenuKeyAction(
  key: string,
  shiftKey: boolean,
  currentIndex: number,
  controlCount: number,
): MobileMenuKeyAction {
  if (key === "Escape") return { kind: "close" };
  if (key !== "Tab" || controlCount < 1) return null;
  if (currentIndex < 0) {
    return { kind: "focus", index: shiftKey ? controlCount - 1 : 0 };
  }
  if (shiftKey && currentIndex === 0) {
    return { kind: "focus", index: controlCount - 1 };
  }
  if (!shiftKey && currentIndex === controlCount - 1) {
    return { kind: "focus", index: 0 };
  }
  return null;
}

export function SiteHeader({
  theme,
  onToggleTheme,
}: {
  theme: ThemePreference;
  onToggleTheme: () => void;
}) {
  const { status } = useAuth();
  const t = useT();
  const [stuck, setStuck] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1025px)");
    const closeAtDesktopWidth = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener("change", closeAtDesktopWidth);
    return () => desktop.removeEventListener("change", closeAtDesktopWidth);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const trigger = menuButtonRef.current;
    const menu = mobileNavRef.current;
    if (!trigger || !menu) return;

    const menuControls = Array.from(
      menu.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    const controls = [trigger, ...menuControls];
    const focusFrame = window.requestAnimationFrame(() => (menuControls[0] ?? trigger).focus());
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveMobileMenuKeyAction(
        event.key,
        event.shiftKey,
        controls.indexOf(document.activeElement as HTMLElement),
        controls.length,
      );
      if (action?.kind === "close") {
        event.preventDefault();
        setMenuOpen(false);
        trigger.focus();
        return;
      }
      if (action?.kind === "focus") {
        event.preventDefault();
        controls[action.index]?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // 已登录时入口指向客户中心，未登录（含会话检查中）指向登录页。
  const authenticated = status === "authenticated";
  const accountHref = authenticated ? "/dashboard" : "/login";
  const accountLabel = authenticated ? t.header.customerCenter : t.header.login;

  return (
    <>
      <a className="home-skip-link" href="#home-main">{t.header.skipToContent}</a>
      <header className={`home-header${stuck ? " is-stuck" : ""}`}>
        <div className="home-wrap home-header-inner">
          <Link to="/" className="home-brand" onClick={() => setMenuOpen(false)} aria-label={t.common.brand}>
            <span className="home-brand-mark" aria-hidden="true" />
          </Link>

          <nav className="home-nav" aria-label={t.header.navLabel}>
            {navEntries.map((entry) => (
              <NavLink
                key={entry.key}
                to={entry.to}
                end={entry.to === "/"}
                className={({ isActive }) => isActive ? "is-active" : undefined}
              >
                {t.header.nav[entry.key]}
              </NavLink>
            ))}
          </nav>

          <div className="home-header-actions">
            <LanguageToggle />
            <button
              type="button"
              className="home-icon-button"
              aria-label={theme === "dark" ? t.common.toLightTheme : t.common.toDarkTheme}
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
              ref={menuButtonRef}
              type="button"
              className="home-icon-button home-menu-button"
              aria-label={menuOpen ? t.header.closeMenu : t.header.openMenu}
              aria-expanded={menuOpen}
              aria-controls="home-mobile-navigation"
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

        <div
          ref={mobileNavRef}
          id="home-mobile-navigation"
          className={`home-mobile-nav${menuOpen ? " is-open" : ""}`}
        >
          <div>
            {navEntries.map((entry) => (
              <NavLink key={entry.key} to={entry.to} end={entry.to === "/"} onClick={() => setMenuOpen(false)}>
                {t.header.nav[entry.key]}
              </NavLink>
            ))}
            <Link to={accountHref} className="home-mobile-login" onClick={() => setMenuOpen(false)}>
              {accountLabel}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

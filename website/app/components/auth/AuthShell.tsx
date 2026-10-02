import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useThemePreference } from "../../lib/theme";
import { LanguageToggle } from "../common/LanguageToggle";
import "./login.css";

/* 登录页与注册页共用的 Auth 外壳：主题切换条 + 居中卡片 + 品牌 + 标题。
   复用 .cc-shell 基座（令牌、字体、背景、滚动条、focus-visible），
   不新建第二套样式系统。 */

const POST_LOGOUT_FOCUS_TARGET_ID = "auth-post-logout-focus";
let postLogoutFocusRequested = false;

export function requestPostLogoutFocus() {
  postLogoutFocusRequested = true;
  const mountedTarget = document.getElementById(POST_LOGOUT_FOCUS_TARGET_ID);
  if (mountedTarget) {
    mountedTarget.focus();
    postLogoutFocusRequested = false;
  }
}

export function AuthShell({
  title,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  subtitle: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const { theme, toggleTheme } = useThemePreference();
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!postLogoutFocusRequested || !headingRef.current) return;
    headingRef.current.focus();
    postLogoutFocusRequested = false;
  }, []);

  return (
    <div className="cc-shell cc-auth" data-theme={theme}>
      <header className="auth-topbar">
        <LanguageToggle />
        <button
          type="button"
          className="auth-theme-toggle"
          aria-label={theme === "dark" ? t.common.toLightTheme : t.common.toDarkTheme}
          aria-pressed={theme === "light"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          )}
        </button>
      </header>

      <main className="auth-main">
        <div className={`auth-card${wide ? " is-wide" : ""}`}>
          <Link className="auth-brand" to="/" aria-label={t.authShell.backHome}>
            <span className="auth-brand-mark" aria-hidden="true" />
            <span className="auth-home-label">{t.authShell.backHome}</span>
          </Link>

          <h1 ref={headingRef} id={POST_LOGOUT_FOCUS_TARGET_ID} tabIndex={-1}>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>

          {children}
        </div>
      </main>
    </div>
  );
}

export function AuthSessionChecking() {
  const { theme } = useThemePreference();
  const t = useT();

  return (
    <div className="cc-shell cc-auth" data-theme={theme}>
      <main className="auth-main">
        <p
          className="auth-session-status"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          {t.authShell.checkingSession}
        </p>
      </main>
    </div>
  );
}

/* 显示/隐藏密码的眼睛图标，登录页与注册页共用。 */
export function RevealIcon({ revealed }: { revealed: boolean }) {
  return revealed ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A9.5 9.5 0 0 1 12 5c5 0 9 4.5 9 7a11 11 0 0 1-2.9 3.7M6.5 6.9C4.2 8.4 3 10.6 3 12c0 2.5 4 7 9 7a9.7 9.7 0 0 0 3.4-.6" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 12c0-2.5 4-7 9-7s9 4.5 9 7-4 7-9 7-9-4.5-9-7z" /><circle cx="12" cy="12" r="2.6" /></svg>
  );
}

/* 提示区：danger 用于错误，neutral 用于“服务尚未接入”这类中性说明。 */
export function AuthNotice({ tone, id, children }: { tone: "danger" | "neutral"; id?: string; children: ReactNode }) {
  return (
    <p className={`auth-error${tone === "neutral" ? " is-neutral" : ""}`} id={id} role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16h.01" /></svg>
      <span>{children}</span>
    </p>
  );
}

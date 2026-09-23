import { useEffect, useState } from "react";
import {
  ReferralPublicApiError,
  referralCodeFromSearch,
  resolvePublicReferral,
} from "../../lib/referral-public-api";
import "../customer/customer-center.css";
import "../auth/login.css";
import "./referral-landing.css";

type LandingState = "loading" | "valid" | "invalid" | "error" | "rate_limited";
type Theme = "dark" | "light";

function initialTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function ReferralLandingPage() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [state, setState] = useState<LandingState>("loading");
  const [publicCode] = useState(() =>
    referralCodeFromSearch(window.location.search),
  );

  useEffect(() => {
    const controller = new AbortController();
    resolvePublicReferral(
      publicCode,
      controller.signal,
    )
      .then((result) => setState(result.valid ? "valid" : "invalid"))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState(
          error instanceof ReferralPublicApiError && error.code === "rate_limited"
            ? "rate_limited"
            : "error",
        );
      });
    return () => controller.abort();
  }, [publicCode]);

  const title =
    state === "loading"
      ? "正在确认推荐链接"
      : state === "valid"
        ? "推荐链接有效"
        : state === "invalid"
          ? "推荐链接不可用"
          : "暂时无法确认推荐链接";
  const subtitle =
    state === "valid"
      ? "推荐链接有效，你可以先了解服务。"
      : state === "invalid"
        ? "请检查链接是否完整，或向分享者重新获取链接。"
        : state === "rate_limited"
          ? "请求过于频繁，请稍后再试。"
          : state === "error"
            ? "服务暂时不可用，请稍后重试。"
            : "正在读取公开链接状态，请稍候。";

  return (
    <div className="cc-shell cc-auth referral-public" data-theme={theme}>
      <header className="auth-topbar">
        <button
          type="button"
          className="auth-theme-toggle"
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          aria-pressed={theme === "light"}
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          )}
        </button>
      </header>

      <main className="auth-main">
        <section className="auth-card referral-public-card" aria-live="polite" aria-busy={state === "loading"}>
          <a className="auth-brand" href="/" aria-label="返回首页">
            <span className="auth-brand-mark" aria-hidden="true" />
            <span className="auth-home-label">返回首页</span>
          </a>

          <div className={`referral-public-status is-${state}`} aria-hidden="true">
            {state === "valid" ? "✓" : state === "loading" ? "…" : "!"}
          </div>
          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>

          <div className="referral-public-actions">
            <p>注册暂未开放。此页面只确认链接状态，不代表推荐归属或佣金资格。</p>
          </div>
        </section>
      </main>
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  ReferralPublicApiError,
  referralCodeFromSearch,
  resolvePublicReferral,
} from "../../lib/referral-public-api";
import { useT } from "../../lib/i18n";
import { LanguageToggle } from "../common/LanguageToggle";
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
  const t = useT();
  const copy = t.referralLanding;
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
      ? copy.titles.loading
      : state === "valid"
        ? copy.titles.valid
        : state === "invalid"
          ? copy.titles.invalid
          : copy.titles.error;
  const subtitle =
    state === "valid"
      ? copy.subtitles.valid
      : state === "invalid"
        ? copy.subtitles.invalid
        : state === "rate_limited"
          ? copy.subtitles.rateLimited
          : state === "error"
            ? copy.subtitles.error
            : copy.subtitles.loading;

  return (
    <div className="cc-shell cc-auth referral-public" data-theme={theme}>
      <header className="auth-topbar">
        <LanguageToggle />
        <button
          type="button"
          className="auth-theme-toggle"
          aria-label={theme === "dark" ? t.common.toLightTheme : t.common.toDarkTheme}
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
          <a className="auth-brand" href="/" aria-label={t.authShell.backHome}>
            <span className="auth-brand-mark" aria-hidden="true" />
            <span className="auth-home-label">{t.authShell.backHome}</span>
          </a>

          <div className={`referral-public-status is-${state}`} aria-hidden="true">
            {state === "valid" ? "✓" : state === "loading" ? "…" : "!"}
          </div>
          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>

          <div className="referral-public-actions">
            <p>{copy.policy}</p>
          </div>
        </section>
      </main>
    </div>
  );
}

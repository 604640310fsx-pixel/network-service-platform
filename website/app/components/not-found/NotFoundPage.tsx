import { Link } from "react-router-dom";
import { useThemePreference } from "../../lib/theme";
import { SiteHeader } from "../home/SiteHeader";
import "../customer/customer-center.css";
import "../home/home.css";
import "./not-found.css";

export function NotFoundPage() {
  const { theme, toggleTheme } = useThemePreference();

  return (
    <div className="cc-shell cc-home not-found-shell" data-theme={theme}>
      <SiteHeader theme={theme} onToggleTheme={toggleTheme} />

      <main className="not-found-main">
        <section className="not-found-card" aria-labelledby="not-found-title">
          <span className="not-found-code" aria-hidden="true">404</span>
          <h1 id="not-found-title">页面不存在</h1>
          <p>抱歉，你访问的页面不存在或地址有误。</p>
          <Link to="/" className="not-found-home-link">
            返回首页
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M5 12h13M12 5.5 18.5 12 12 18.5" />
            </svg>
          </Link>
        </section>
      </main>
    </div>
  );
}

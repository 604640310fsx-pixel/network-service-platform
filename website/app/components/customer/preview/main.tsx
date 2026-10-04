import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, useLocation, useSearchParams } from "react-router-dom";
import { AuthProvider } from "../../../lib/auth";
import { I18nProvider, useI18n } from "../../../lib/i18n";
import { CustomerCenterShell } from "../CustomerCenterShell";
import { CustomerTicketsPage } from "../CustomerTicketsPage";
import { BuyerNetworkPage } from "../../network/BuyerNetworkPage";
import { ProfilePage } from "../../profile/ProfilePage";
import { ReferralCenter } from "../../referrals/ReferralCenter";
import "../../../globals.css";

/* Local-only synthetic preview. No production API, subscription URL, customer identity or
   ticket write is reachable: every /api request is answered here, and POST always fails. */
const service = {
  orderRef: "DLDEMO1", amountFen: 100, currency: "CNY", orderStatus: "paid",
  serviceStatus: "open", createdAt: "2026-01-01T00:00:00.000Z",
  endsAt: null, planLabel: null,
};
let ticketServiceReads = 0;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (!path.pathname.startsWith("/api/")) return originalFetch(input, init);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method !== "GET") return json({ error: { code: "preview_read_only" } }, 503);
  if (path.pathname === "/api/auth/me") {
    return json({ user: { email: "demo@example.test", role: "user" }, csrfToken: "A".repeat(43) });
  }
  if (path.pathname === "/api/me/services") {
    if ((window.location.pathname === "/tickets" || new URLSearchParams(window.location.search).get("fail") === "1") && ticketServiceReads++ < 2) {
      return json({ error: { code: "preview_retry" } }, 503);
    }
    return json({ items: [service] });
  }
  if (path.pathname === "/api/me/orders") return json({ items: [] });
  if (path.pathname === "/api/me/delivery-lines") return json({ items: [
    { orderRef: "DLDEMO1", position: 1, label: "演示线路一" },
    { orderRef: "DLDEMO1", position: 2, label: "演示线路二" },
  ] });
  if (path.pathname === "/api/me/node-status") return json({ monitor: "available", items: [
    { kind: "service", ref: "DLDEMO1", position: 1, label: "演示线路一", status: "online" },
    { kind: "service", ref: "DLDEMO1", position: 2, label: "演示线路二", status: "unknown" },
  ] });
  if (path.pathname === "/api/me/subscription-info") {
    return json(path.searchParams.get("line") === "service:DLDEMO1:1"
      ? { info: { upload: 0, download: 0, total: 1024, expire: null } }
      : { info: { upload: null, download: 10, total: null, expire: null } });
  }
  if (path.pathname === "/api/me/tickets") return json({ items: [], page: 1, hasMore: false });
  return json({ error: { code: "preview_unavailable" } }, 503);
};

function PreviewBar() {
  const { lang, setLang } = useI18n();
  const labels = lang === "zh"
    ? { tickets: "工单", network: "流量", profile: "资料", referrals: "推荐" }
    : { tickets: "Tickets", network: "Traffic", profile: "Profile", referrals: "Referrals" };
  return (
    <aside style={{ padding: "12px 20px", background: "#fff1d6", color: "#5d3b00", display: "flex", gap: 16, flexWrap: "wrap" }}>
      <strong>{lang === "zh" ? "演示数据 · 非报价" : "Demo data · not a quote"}</strong>
      <Link to="/customer-gaps-preview.html?section=tickets&new=1&fail=1">{labels.tickets}</Link>
      <Link to="/customer-gaps-preview.html?section=network">{labels.network}</Link>
      <Link to="/customer-gaps-preview.html?section=profile">{labels.profile}</Link>
      <Link to="/customer-gaps-preview.html?section=referrals">{labels.referrals}</Link>
      <button type="button" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "English" : "中文"}</button>
    </aside>
  );
}

function Preview() {
  const { t } = useI18n();
  const pages = t.center.pages;
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const section = params.get("section") ?? pathname.slice(1);
  const page = section === "network" ? pages.network
    : section === "profile" ? pages.profile
      : section === "referrals" ? pages.referrals : pages.tickets;
  const component = section === "network" ? <BuyerNetworkPage />
    : section === "profile" ? <ProfilePage />
      : section === "referrals" ? <ReferralCenter /> : <CustomerTicketsPage />;
  return <><PreviewBar /><CustomerCenterShell title={page.title} description={page.description}>{component}</CustomerCenterShell></>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><I18nProvider><AuthProvider><Preview /></AuthProvider></I18nProvider></BrowserRouter></StrictMode>,
);

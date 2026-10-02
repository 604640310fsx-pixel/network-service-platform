import { useParams } from "react-router-dom";
import { useT } from "../lib/i18n";
import { CustomerCenterShell } from "./customer/CustomerCenterShell";
import { CustomerOrdersPage } from "./customer/CustomerOrdersPage";
import { CustomerServicesPage } from "./customer/CustomerServicesPage";
import { CustomerInvitesPage } from "./customer/CustomerInvitesPage";
import { CustomerTicketsPage } from "./customer/CustomerTicketsPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { DocsLibrary } from "./docs/DocsLibrary";
import { SUBSCRIPTION_IMPORT_ARTICLES } from "./docs/docsModel";
import { CustomerShellMonitor, PublicMonitorPage } from "./monitor/PublicMonitorPage";
import { BuyerNetworkPage } from "./network/BuyerNetworkPage";
import { NotFoundPage } from "./not-found/NotFoundPage";
import { ProfilePage } from "./profile/ProfilePage";
import { ReferralCenterAdapter } from "./referrals/ReferralCenterAdapter";
import { SubscribePage } from "./subscribe/SubscribePage";
import type { SectionKey } from "../lib/sections";
import { sectionKeys } from "../lib/sections";

export function DashboardShell() {
  const { section: requestedSection = "dashboard" } = useParams();
  const pages = useT().center.pages;

  if (!sectionKeys.includes(requestedSection as SectionKey)) {
    return <NotFoundPage />;
  }

  const section = requestedSection as SectionKey;
  // /status 显示同一公开 3002 监控，始终在客户中心壳层内；无需登录，也不跳到官网公开页。
  if (section === "status") {
    return (
      <CustomerCenterShell fill title={pages.status.title} description={pages.status.description}>
        <CustomerShellMonitor />
      </CustomerCenterShell>
    );
  }
  if (section === "subscribe") {
    return (
      <CustomerCenterShell
        title={pages.subscribe.title}
        description={pages.subscribe.description}
      >
        <SubscribePage />
      </CustomerCenterShell>
    );
  }
  if (section === "dashboard") {
    return (
      <CustomerCenterShell title={pages.dashboard.title} description={pages.dashboard.description}>
        <DashboardPage />
      </CustomerCenterShell>
    );
  }
  if (section === "services") {
    return (
      <CustomerCenterShell title={pages.services.title} description={pages.services.description}>
        <CustomerServicesPage />
      </CustomerCenterShell>
    );
  }
  if (section === "orders") {
    return (
      <CustomerCenterShell title={pages.orders.title} description={pages.orders.description}>
        <CustomerOrdersPage />
      </CustomerCenterShell>
    );
  }
  if (section === "docs") {
    return (
      <CustomerCenterShell title={pages.docs.title} description={pages.docs.description}>
        <DocsLibrary articles={SUBSCRIPTION_IMPORT_ARTICLES} />
      </CustomerCenterShell>
    );
  }
  if (section === "profile") {
    return (
      <CustomerCenterShell title={pages.profile.title} description={pages.profile.description}>
        <ProfilePage />
      </CustomerCenterShell>
    );
  }
  if (section === "referrals") {
    return (
      <CustomerCenterShell title={pages.referrals.title} description={pages.referrals.description}>
        <ReferralCenterAdapter />
      </CustomerCenterShell>
    );
  }
  if (section === "tickets") {
    return (
      <CustomerCenterShell title={pages.tickets.title} description={pages.tickets.description}>
        <CustomerTicketsPage />
      </CustomerCenterShell>
    );
  }
  if (section === "invites") {
    return (
      <CustomerCenterShell title={pages.invites.title} description={pages.invites.description}>
        <CustomerInvitesPage />
      </CustomerCenterShell>
    );
  }
  if (section === "network") {
    return (
      <CustomerCenterShell title={pages.network.title} description={pages.network.description}>
        <BuyerNetworkPage />
      </CustomerCenterShell>
    );
  }
  // /monitor 是公开官网页面：走官网壳层，不进入客户中心壳层。
  if (section === "monitor") {
    return <PublicMonitorPage />;
  }

  return <NotFoundPage />;
}

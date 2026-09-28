import { useParams } from "react-router-dom";
import { CustomerCenterShell } from "./customer/CustomerCenterShell";
import { CustomerOrdersPage } from "./customer/CustomerOrdersPage";
import { CustomerServicesPage } from "./customer/CustomerServicesPage";
import { CustomerInvitesPage } from "./customer/CustomerInvitesPage";
import { CustomerTicketsPage } from "./customer/CustomerTicketsPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { DocsLibrary } from "./docs/DocsLibrary";
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

  if (!sectionKeys.includes(requestedSection as SectionKey)) {
    return <NotFoundPage />;
  }

  const section = requestedSection as SectionKey;
  // /status 显示同一公开 3002 监控，始终在客户中心壳层内；无需登录，也不跳到官网公开页。
  if (section === "status") {
    return (
      <CustomerCenterShell fill title="服务器状态" description="查看公开运营方三网实时监控">
        <CustomerShellMonitor />
      </CustomerCenterShell>
    );
  }
  if (section === "subscribe") {
    return (
      <CustomerCenterShell
        title="套餐订阅"
        description="选择方案并提交需求，完成付款后进入人工交付流程"
      >
        <SubscribePage />
      </CustomerCenterShell>
    );
  }
  if (section === "dashboard") {
    return (
      <CustomerCenterShell title="仪表板" description="查看服务概览、当前服务与网络状态">
        <DashboardPage />
      </CustomerCenterShell>
    );
  }
  if (section === "services") {
    return (
      <CustomerCenterShell title="当前套餐" description="查看已支付服务与人工开通进度">
        <CustomerServicesPage />
      </CustomerCenterShell>
    );
  }
  if (section === "orders") {
    return (
      <CustomerCenterShell title="订单" description="查看你的订单、支付状态与开通进度">
        <CustomerOrdersPage />
      </CustomerCenterShell>
    );
  }
  if (section === "docs") {
    return (
      <CustomerCenterShell title="使用文档" description="搜索并阅读已批准的客户端与服务使用说明">
        <DocsLibrary />
      </CustomerCenterShell>
    );
  }
  if (section === "profile") {
    return (
      <CustomerCenterShell title="个人中心" description="查看当前登录账户的只读资料">
        <ProfilePage />
      </CustomerCenterShell>
    );
  }
  if (section === "referrals") {
    return (
      <CustomerCenterShell title="邀请/推广" description="查看推荐链接、待确认来源和当前接入状态">
        <ReferralCenterAdapter />
      </CustomerCenterShell>
    );
  }
  if (section === "tickets") {
    return (
      <CustomerCenterShell title="工单" description="提交问题并查看客服的文字回复">
        <CustomerTicketsPage />
      </CustomerCenterShell>
    );
  }
  if (section === "invites") {
    return (
      <CustomerCenterShell title="邀请中心" description="查看你的个人邀请码与直接邀请人数">
        <CustomerInvitesPage />
      </CustomerCenterShell>
    );
  }
  if (section === "network") {
    return (
      <CustomerCenterShell title="节点与流量" description="查看账户服务、节点状态与流量数据接入情况">
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

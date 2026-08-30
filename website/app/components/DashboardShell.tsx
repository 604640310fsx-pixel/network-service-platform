import { Navigate, useParams } from "react-router-dom";
import { CustomerCenterShell } from "./customer/CustomerCenterShell";
import { CustomerOrdersPage } from "./customer/CustomerOrdersPage";
import { CustomerServicesPage } from "./customer/CustomerServicesPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { PublicMonitorPage } from "./monitor/PublicMonitorPage";
import { BuyerNetworkPage } from "./network/BuyerNetworkPage";
import { BuyerServerStatusPage } from "./status/BuyerServerStatusPage";
import { SubscribePage } from "./subscribe/SubscribePage";
import type { SectionKey } from "../lib/sections";
import { sectionKeys } from "../lib/sections";

export function DashboardShell() {
  const { section: requestedSection = "dashboard" } = useParams();

  if (!sectionKeys.includes(requestedSection as SectionKey)) {
    return <Navigate to="/dashboard" replace />;
  }

  const section = requestedSection as SectionKey;
  if (section === "status") {
    return (
      <CustomerCenterShell fill title="服务器状态" description="查看 3002 实时监控；从已交付线路进入时自动选择对应 VPS">
        <BuyerServerStatusPage />
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

  return <Navigate to="/dashboard" replace />;
}

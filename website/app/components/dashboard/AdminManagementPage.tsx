import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { CustomerCenterShell } from "../customer/CustomerCenterShell";
import { AdminCouponsPanel } from "./AdminCouponsPanel";
import { AdminDiagnosisPanel } from "./AdminDiagnosisPanel";
import { AdminInviteCodesPanel } from "./AdminInviteCodesPanel";
import { AdminOrdersPanel } from "./AdminOrdersPanel";
import { AdminPendingServices } from "./AdminPendingServices";
import { AdminServiceChangePanel } from "./AdminServiceChangePanel";
import { AdminPlansPanel } from "./AdminPlansPanel";
import { AdminTicketsPanel } from "./AdminTicketsPanel";
import { AdminUserServicesPanel } from "./AdminUserServicesPanel";
import "./dashboard.css";

type AdminTab = "plans" | "users" | "orders" | "services" | "support" | "marketing";

const tabs: ReadonlyArray<{ id: AdminTab; label: string; description: string }> = [
  { id: "plans", label: "套餐与目录", description: "分开管理目录开关和套餐价格、库存、逐项停售" },
  { id: "users", label: "用户", description: "浏览用户列表，按邮箱筛选并查看已有服务" },
  { id: "orders", label: "订单", description: "按订单号或用户 ID 筛选并查看已有订单" },
  { id: "services", label: "服务", description: "待开通服务与已有服务变更" },
  { id: "support", label: "支持", description: "工单和诊断请求" },
  { id: "marketing", label: "邀请与优惠", description: "邀请码和优惠券" },
];

function tabFromHash(hash: string): AdminTab {
  if (hash === "#admin-service-changes") return "services";
  const value = hash.slice(1);
  return tabs.find((tab) => tab.id === value)?.id ?? "plans";
}

export function AdminManagementPage() {
  const { csrfToken } = useAuth();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<AdminTab>(() => tabFromHash(hash));

  useEffect(() => setActiveTab(tabFromHash(hash)), [hash]);

  function selectTab(tab: AdminTab) {
    setActiveTab(tab);
    navigate(`/admin#${tab}`, { replace: true });
  }

  const current = tabs.find((tab) => tab.id === activeTab)!;
  return (
    <CustomerCenterShell title="管理中心" description="使用现有管理员会话管理业务记录">
      <main className="dash-page">
        <div className="dash-layout">
          <section className="dash-panel admin-workspace" aria-label="管理模块">
            {(import.meta.env.VITE_ADMIN_SYNTHETIC_PREVIEW === "true" || import.meta.env.VITE_ADMIN_REAL_PREVIEW === "true") &&
              <p className="admin-preview-label" role="status">{import.meta.env.VITE_ADMIN_REAL_PREVIEW === "true"
                ? "隔离合成库 · 真实后端联测 · 非报价" : "演示数据 · 非报价 · 仅用于本地页面验收"}</p>}
            <div className="admin-workspace-heading">
              <div><h2>管理工作台</h2><p>{current.description}</p></div>
              <span>仅管理员可访问</span>
            </div>
            <nav className="admin-workspace-tabs" aria-label="管理模块">
              {tabs.map((tab) => (
                <button key={tab.id} type="button" aria-current={activeTab === tab.id ? "page" : undefined}
                  className={activeTab === tab.id ? "is-active" : undefined} onClick={() => selectTab(tab.id)}>
                  {tab.label}
                </button>
              ))}
            </nav>
          </section>
          {activeTab === "plans" && <AdminPlansPanel csrfToken={csrfToken} />}
          {activeTab === "users" && <AdminUserServicesPanel csrfToken={csrfToken} />}
          {activeTab === "orders" && <AdminOrdersPanel csrfToken={csrfToken} />}
          {activeTab === "services" && <>
            <AdminServiceChangePanel csrfToken={csrfToken} />
            <AdminPendingServices csrfToken={csrfToken} />
          </>}
          {activeTab === "support" && <>
            <AdminTicketsPanel csrfToken={csrfToken} />
            <AdminDiagnosisPanel csrfToken={csrfToken} />
          </>}
          {activeTab === "marketing" && <>
            <AdminInviteCodesPanel csrfToken={csrfToken} />
            <AdminCouponsPanel csrfToken={csrfToken} />
          </>}
        </div>
      </main>
    </CustomerCenterShell>
  );
}

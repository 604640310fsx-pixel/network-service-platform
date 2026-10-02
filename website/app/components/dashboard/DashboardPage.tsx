import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { AdminCouponsPanel } from "./AdminCouponsPanel";
import { AdminDiagnosisPanel } from "./AdminDiagnosisPanel";
import { AdminInviteCodesPanel } from "./AdminInviteCodesPanel";
import { AdminPendingServices } from "./AdminPendingServices";
import { AdminPlansPanel } from "./AdminPlansPanel";
import { AdminTicketsPanel } from "./AdminTicketsPanel";
import { AdminUserServicesPanel } from "./AdminUserServicesPanel";
import { BuyerDashboardOverview } from "./BuyerDashboardOverview";
import "./dashboard.css";

/* 买家概览只读取既有 /api/me/services 与 /api/me/orders；节点、流量等未提供
   公共契约的数据始终显示待接入，不使用硬编码或 Mock 数值。管理员面板权限保持不变。 */

const quickActions = ["/subscribe", "/services", "/orders", "/network", "/monitor", "/tickets"] as const;

function ActionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18M8 15h4" />
    </svg>
  );
}

export function DashboardPage() {
  const { principal, csrfToken } = useAuth();
  const copy = useT().dashboard;

  return (
    <main className="dash-page">
      <div className="dash-layout">
        <BuyerDashboardOverview />

        {principal?.role === "admin" && <AdminDiagnosisPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminInviteCodesPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminPendingServices csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminUserServicesPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminPlansPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminCouponsPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminTicketsPanel csrfToken={csrfToken} />}

        <section className="dash-panel" aria-labelledby="dash-actions-title">
          <h2 id="dash-actions-title"><em>ACTIONS</em>{copy.actionsTitle}</h2>
          <div className="dash-action-grid">
            {quickActions.map((href) => (
              <Link className="dash-action" to={href} key={href}>
                <ActionIcon />
                <span><strong>{copy.actions[href].label}</strong><small>{copy.actions[href].hint}</small></span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

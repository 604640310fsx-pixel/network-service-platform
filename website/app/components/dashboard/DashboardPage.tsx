import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { AdminCouponsPanel } from "./AdminCouponsPanel";
import { AdminDiagnosisPanel } from "./AdminDiagnosisPanel";
import { AdminInviteCodesPanel } from "./AdminInviteCodesPanel";
import { AdminPendingServices } from "./AdminPendingServices";
import { AdminPlansPanel } from "./AdminPlansPanel";
import { BuyerDashboardOverview } from "./BuyerDashboardOverview";
import "./dashboard.css";

/* 买家概览只读取既有 /api/me/services 与 /api/me/orders；节点、流量等未提供
   公共契约的数据始终显示待接入，不使用硬编码或 Mock 数值。管理员面板权限保持不变。 */

const quickActions = [
  { href: "/subscribe", label: "套餐订阅", hint: "选择并配置新套餐" },
  { href: "/services", label: "当前套餐", hint: "查看已支付服务与开通进度" },
  { href: "/orders", label: "订单", hint: "查看订单与支付状态" },
  { href: "/network", label: "节点与流量", hint: "查看账户内网络数据接入状态" },
  { href: "/monitor", label: "实时监控", hint: "查看三网实时网络状态" },
] as const;

const pendingActions = [
  { label: "工单", hint: "待接入" },
] as const;

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

  return (
    <main className="dash-page">
      <div className="dash-layout">
        <BuyerDashboardOverview />

        {principal?.role === "admin" && <AdminDiagnosisPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminInviteCodesPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminPendingServices csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminPlansPanel csrfToken={csrfToken} />}
        {principal?.role === "admin" && <AdminCouponsPanel csrfToken={csrfToken} />}

        <section className="dash-panel" aria-labelledby="dash-actions-title">
          <h2 id="dash-actions-title"><em>ACTIONS</em>快捷操作</h2>
          <div className="dash-action-grid">
            {quickActions.map((action) => (
              <Link className="dash-action" to={action.href} key={action.href}>
                <ActionIcon />
                <span><strong>{action.label}</strong><small>{action.hint}</small></span>
              </Link>
            ))}
            {pendingActions.map((action) => (
              <button
                type="button"
                className="dash-action"
                key={action.label}
                disabled
                aria-disabled="true"
                title={`${action.label}待接入`}
              >
                <ActionIcon />
                <span><strong>{action.label}</strong><small>{action.hint}</small></span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

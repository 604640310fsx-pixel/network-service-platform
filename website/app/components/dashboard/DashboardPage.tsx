import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { AdminCouponsPanel } from "./AdminCouponsPanel";
import { AdminDiagnosisPanel } from "./AdminDiagnosisPanel";
import { AdminPendingServices } from "./AdminPendingServices";
import { AdminPlansPanel } from "./AdminPlansPanel";
import { CurrentServicesPanel } from "./CurrentServicesPanel";
import "./dashboard.css";

/* 说明：当前服务与管理员待开通列表接真实 API；其余业务数值仍是“待接入”占位。
   Dashboard 不接入监控指标，只提供已经上线的公开 /monitor 页面入口。 */

const PENDING = "—";

const overviewStats = [
  { label: "运行中服务", status: "待接入" },
  { label: "本月用量", status: "暂无数据" },
  { label: "最近到期", status: "暂无数据" },
  { label: "工单与告警", status: "待接入" },
] as const;

const quickActions = [
  { href: "/subscribe", label: "套餐订阅", hint: "选择并配置新套餐" },
  { href: "/services", label: "当前套餐", hint: "查看已支付服务与开通进度" },
  { href: "/orders", label: "订单", hint: "查看订单与支付状态" },
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
        <section className="dash-panel" aria-labelledby="dash-overview-title">
          <h2 id="dash-overview-title"><em>OVERVIEW</em>服务概览<span>数据待接入</span></h2>
          <div className="dash-stat-grid">
            {overviewStats.map((stat) => (
              <article className="dash-stat" key={stat.label}>
                <span>{stat.label}</span>
                <strong>{PENDING}</strong>
                <small><i aria-hidden="true" />{stat.status}</small>
              </article>
            ))}
          </div>
        </section>

        <div className="dash-split">
          <section className="dash-panel" aria-labelledby="dash-service-title">
            <h2 id="dash-service-title"><em>SERVICE</em>当前服务</h2>
            <CurrentServicesPanel />
          </section>

          <section className="dash-panel" aria-labelledby="dash-network-title">
            <h2 id="dash-network-title"><em>NETWORK</em>网络状态</h2>
            <div className="dash-service">
              <div className="dash-service-head">
                <div>
                  <strong>实时网络监控已上线</strong>
                  <small>本页不展示实时指标，前往实时监控查看三网线路与运行状态。</small>
                </div>
              </div>
              <div className="dash-service-foot">
                <Link className="dash-primary-link" to="/monitor">查看实时监控</Link>
              </div>
            </div>
          </section>
        </div>

        {principal?.role === "admin" && <AdminDiagnosisPanel csrfToken={csrfToken} />}
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

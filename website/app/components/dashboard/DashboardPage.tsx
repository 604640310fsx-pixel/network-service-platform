import { Link } from "react-router-dom";
import "./dashboard.css";

/* 说明：本页所有业务数值均为“待接入”占位。
   真实套餐、用量、到期、余额与监控数据尚未冻结，一律显示 —，不得在此编造。 */

const PENDING = "—";

const overviewStats = [
  { label: "运行中服务", status: "待接入" },
  { label: "本月用量", status: "暂无数据" },
  { label: "最近到期", status: "暂无数据" },
  { label: "工单与告警", status: "待接入" },
] as const;

const serviceFacts = [
  { term: "地区", value: PENDING },
  { term: "到期时间", value: PENDING },
  { term: "使用量", value: PENDING },
  { term: "状态", value: "待接入" },
] as const;

const networkProbes = ["广州电信", "广州联通", "广州移动"] as const;

const pendingActions = [
  { label: "当前套餐", hint: "待接入" },
  { label: "订单", hint: "待接入" },
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
            <div className="dash-service">
              <div className="dash-service-head">
                <div>
                  <strong>{PENDING}</strong>
                  <small>套餐名称待接入</small>
                </div>
                <span className="dash-tag">待接入</span>
              </div>
              <dl className="dash-service-facts">
                {serviceFacts.map((fact) => (
                  <div key={fact.term}>
                    <dt>{fact.term}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="dash-service-foot">
                <p>尚未接入真实套餐数据，可前往套餐订阅查看可选方案。</p>
                <Link className="dash-primary-link" to="/subscribe">前往套餐订阅</Link>
              </div>
            </div>
          </section>

          <section className="dash-panel" aria-labelledby="dash-network-title">
            <h2 id="dash-network-title"><em>NETWORK</em>网络状态</h2>
            <div className="dash-network">
              {networkProbes.map((probe) => (
                <div key={probe}><span>{probe}</span><b>{PENDING}</b></div>
              ))}
              <footer><i aria-hidden="true" />监控数据待接入</footer>
            </div>
          </section>
        </div>

        <section className="dash-panel" aria-labelledby="dash-actions-title">
          <h2 id="dash-actions-title"><em>ACTIONS</em>快捷操作</h2>
          <div className="dash-action-grid">
            <Link className="dash-action" to="/subscribe">
              <ActionIcon />
              <span><strong>套餐订阅</strong><small>选择并配置新套餐</small></span>
            </Link>
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

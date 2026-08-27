import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyOrders,
  type MyOrderItem,
  type PaymentOrderStatus,
  type ServiceStatus,
} from "../../lib/payment-api";
import "./customer-orders.css";

/* /orders 客户中心「订单」页：数据只来自 GET /api/me/orders（listMyOrders），
   仅展示公共契约允许的客户字段。不展示 contact / notes / scenarios / tradeNo /
   outTradeNo / paymentId / serviceId / userId / token / 内部资源；失败一律真实错误态，
   绝不回退硬编码 / Mock 数据。列表不在前端重排，保持后端排序。 */

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyOrderItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

const ORDER_STATUS_LABEL: Record<PaymentOrderStatus, string> = {
  pending: "待支付",
  paid: "已支付",
  closed: "已关闭",
};

const ORDER_STATUS_MODIFIER: Record<PaymentOrderStatus, string> = {
  pending: "is-pending",
  paid: "is-paid",
  closed: "is-closed",
};

function serviceStatusLabel(status: ServiceStatus | null): string {
  if (status === null) return "无服务";
  return status === "open" ? "已开通" : "待开通";
}

function formatFen(amountFen: number): string {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function genericErrorMessage(error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return "订单数据返回异常，请稍后重试。";
  }
  return "暂时无法读取订单，请稍后重试。";
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-ord-page">
      <div className="cc-ord-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>ORDERS</em>
        <h2>订单列表</h2>
      </div>
      <span className="cc-ord-tag">{tag}</span>
    </div>
  );
}

export function CustomerOrdersPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyOrders(controller.signal)
      .then((items) => {
        if (stopped) return;
        // 不重排：后端已按 createdAt DESC / id DESC 排序，前端保持原样。
        setState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: genericErrorMessage(error) });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  if (state.kind === "loading") {
    return (
      <PageFrame>
        <section className="cc-ord-panel" role="status" aria-live="polite" aria-busy="true">
          <PanelHead tag="加载中" />
          <ul className="cc-ord-skeleton" aria-hidden="true">
            <li /><li /><li />
          </ul>
          <p className="cc-ord-status-text">正在读取订单…</p>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <PageFrame>
        <section className="cc-ord-panel" role="alert">
          <PanelHead tag="登录失效" />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">登录状态已失效，请重新登录。</p>
            <p className="cc-ord-notice-hint">重新登录后即可查看你的订单。</p>
            <div className="cc-ord-notice-actions">
              {/* 会话失效恢复：必须整页导航而非 SPA Link。AuthProvider 仅在首次挂载时
                  检查 /api/auth/me，之后 /api/me/orders 的 401 不会把 status 从
                  authenticated 降级；用 <Link> 时 LoginRoute 会读到旧的 authenticated
                  并立即重定向回 /dashboard。原生 <a> 触发整页加载，强制重新检查会话。 */}
              <a className="cc-ord-primary" href="/login">重新登录</a>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "error") {
    return (
      <PageFrame>
        <section className="cc-ord-panel" role="alert">
          <PanelHead tag="读取失败" />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">{state.message}</p>
            <p className="cc-ord-notice-hint">网络恢复后可重新读取订单列表。</p>
            <div className="cc-ord-notice-actions">
              <button
                type="button"
                className="cc-ord-primary"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                重新加载
              </button>
              <Link className="cc-ord-ghost" to="/subscribe">前往套餐订阅</Link>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  const { items } = state;
  if (items.length === 0) {
    return (
      <PageFrame>
        <section className="cc-ord-panel">
          <PanelHead tag="暂无订单" />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">暂无订单</p>
            <p className="cc-ord-notice-hint">选择套餐并提交需求后，你的订单会显示在这里。</p>
            <div className="cc-ord-notice-actions">
              <Link className="cc-ord-primary" to="/subscribe">选择套餐</Link>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  const pendingCount = items.filter((item) => item.status === "pending").length;
  const paidCount = items.filter((item) => item.status === "paid").length;

  return (
    <PageFrame>
      <section className="cc-ord-summary" aria-label="订单概览">
        <article>
          <span>订单总数</span>
          <strong>{items.length}</strong>
          <small>全部订单</small>
        </article>
        <article>
          <span>待支付</span>
          <strong>{pendingCount}</strong>
          <small>等待付款</small>
        </article>
        <article>
          <span>已支付</span>
          <strong>{paidCount}</strong>
          <small>付款成功</small>
        </article>
      </section>

      <section className="cc-ord-panel">
        <PanelHead tag={`共 ${items.length} 项`} />
        <ul className="cc-ord-list">
          {items.map((item) => (
            <li className="cc-ord-item" key={item.orderRef}>
              <div className="cc-ord-item-head">
                <div className="cc-ord-item-id">
                  <strong>{item.orderRef}</strong>
                  <small>创建于 {formatDate(item.createdAt)}</small>
                </div>
                <span className={`cc-ord-badge ${ORDER_STATUS_MODIFIER[item.status]}`}>
                  {ORDER_STATUS_LABEL[item.status]}
                </span>
              </div>

              <dl className="cc-ord-facts">
                <div>
                  <dt>金额</dt>
                  <dd>{formatFen(item.amountFen)}</dd>
                </div>
                <div>
                  <dt>服务状态</dt>
                  <dd>{serviceStatusLabel(item.serviceStatus)}</dd>
                </div>
                <div>
                  <dt>地区</dt>
                  <dd>{item.regionId}</dd>
                </div>
                <div>
                  <dt>运营商</dt>
                  <dd>{item.ispId}</dd>
                </div>
                <div>
                  <dt>时长</dt>
                  <dd>{item.durationId}</dd>
                </div>
                <div>
                  <dt>类型</dt>
                  <dd>{item.specId === null ? item.typeId : `${item.typeId} · ${item.specId}`}</dd>
                </div>
              </dl>

              {item.status === "pending" && item.reservedUntil !== null && (
                <p className="cc-ord-reserved">
                  <span>付款保留至</span>
                  <b>{formatDate(item.reservedUntil)}</b>
                </p>
              )}

              <div className="cc-ord-item-foot">
                <Link
                  className="cc-ord-ghost"
                  to={`/subscribe/request?orderRef=${encodeURIComponent(item.orderRef)}`}
                >
                  查看订单状态
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </PageFrame>
  );
}

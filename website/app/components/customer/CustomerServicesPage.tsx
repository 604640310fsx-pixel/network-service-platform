import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getPaymentOrder,
  getMyServices,
  type MyServiceItem,
  type PaymentOrderSnapshot,
  type PaymentOrderStatus,
  type ServiceDeliveryItem,
  type ServiceStatus,
} from "../../lib/payment-api";
import { SubscriptionImportModule } from "../subscription-import";
import "./customer-services.css";

/* /services 列表只来自 GET /api/me/services；已开通卡片的交付数据按其 orderRef
   独立读取现有授权订单快照，不从仅含线路名称的 delivery-lines 接口推导地址。
   失败或快照与卡片不一致时不展示地址，也不回退 Mock。 */

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyServiceItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

type DeliveryState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly ServiceDeliveryItem[] }
  | { readonly kind: "error"; readonly message: string };

const ORDER_STATUS_LABEL: Record<PaymentOrderStatus, string> = {
  pending: "待支付",
  paid: "已支付",
  closed: "已关闭",
};

function serviceStatusLabel(status: ServiceStatus): string {
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
    return "服务数据返回异常，请稍后重试。";
  }
  return "暂时无法读取服务状态，请稍后重试。";
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-svc-page">
      <div className="cc-svc-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  return (
    <div className="cc-svc-panel-head">
      <div>
        <em>SERVICES</em>
        <h2>服务清单</h2>
      </div>
      <span className="cc-svc-tag">{tag}</span>
    </div>
  );
}

export function ownedDeliveryItems(
  item: MyServiceItem,
  snapshot: PaymentOrderSnapshot,
): readonly ServiceDeliveryItem[] | null {
  if (
    item.serviceStatus !== "open" ||
    snapshot.orderRef !== item.orderRef ||
    snapshot.status !== item.orderStatus ||
    snapshot.amountFen !== item.amountFen ||
    snapshot.currency !== item.currency ||
    snapshot.service?.status !== "open"
  ) {
    return null;
  }
  return snapshot.service.items ?? [];
}

function ServiceSubscription({ item }: { item: MyServiceItem }) {
  const [state, setState] = useState<DeliveryState>({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getPaymentOrder(item.orderRef, null, controller.signal)
      .then((snapshot) => {
        if (stopped) return;
        const deliveryItems = ownedDeliveryItems(item, snapshot);
        if (deliveryItems === null) {
          setState({ kind: "error", message: "交付数据与当前套餐不一致，请稍后重试。" });
          return;
        }
        setState({ kind: "ready", items: deliveryItems });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof PaymentApiError && error.code === "invalid_response"
          ? "交付数据返回异常，请稍后重试。"
          : "订阅信息暂不可读取，请稍后重试。";
        setState({ kind: "error", message });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [item.orderRef, item.orderStatus, item.amountFen, item.currency, item.serviceStatus, retryToken]);

  return (
    <section className="cc-svc-import" aria-label={`套餐 ${item.orderRef} 的订阅信息`}>
      {state.kind === "loading" && (
        <p className="cc-svc-import-state" role="status">正在读取此套餐的订阅信息…</p>
      )}
      {state.kind === "error" && (
        <div className="cc-svc-import-state" role="alert">
          <p>{state.message}</p>
          <button type="button" className="cc-svc-ghost" onClick={() => setRetryToken((token) => token + 1)}>
            重试读取
          </button>
        </div>
      )}
      {state.kind === "ready" && <SubscriptionImportModule deliveryItems={state.items} compact />}
      <div className="cc-svc-import-links">
        <Link to="/docs">查看导入教程</Link>
        <Link to={`/subscribe/request?orderRef=${encodeURIComponent(item.orderRef)}`}>查看订单详情</Link>
      </div>
    </section>
  );
}

export function CustomerServicesPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyServices(controller.signal)
      .then((items) => {
        if (stopped) return;
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
        <section className="cc-svc-panel" role="status" aria-live="polite" aria-busy="true">
          <PanelHead tag="加载中" />
          <ul className="cc-svc-skeleton" aria-hidden="true">
            <li /><li /><li />
          </ul>
          <p className="cc-svc-status-text">正在读取服务状态…</p>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <PageFrame>
        <section className="cc-svc-panel" role="alert">
          <PanelHead tag="登录失效" />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">登录状态已失效，请重新登录。</p>
            <p className="cc-svc-notice-hint">重新登录后即可查看你的服务与开通进度。</p>
            <div className="cc-svc-notice-actions">
              {/* 会话失效恢复：必须整页导航而非 SPA Link。AuthProvider 仅在首次挂载时
                  检查 /api/auth/me，之后 /api/me/services 的 401 不会把 status 从
                  authenticated 降级；用 <Link> 时 LoginRoute 会读到旧的 authenticated
                  并立即重定向回 /dashboard。原生 <a> 触发整页加载，强制重新检查会话。 */}
              <a className="cc-svc-primary" href="/login">重新登录</a>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "error") {
    return (
      <PageFrame>
        <section className="cc-svc-panel" role="alert">
          <PanelHead tag="读取失败" />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">{state.message}</p>
            <p className="cc-svc-notice-hint">网络恢复后可重新读取服务列表。</p>
            <div className="cc-svc-notice-actions">
              <button
                type="button"
                className="cc-svc-primary"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                重新加载
              </button>
              <Link className="cc-svc-ghost" to="/subscribe">前往套餐订阅</Link>
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
        <section className="cc-svc-panel">
          <PanelHead tag="暂无服务" />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">暂无已支付服务</p>
            <p className="cc-svc-notice-hint">完成付款后，你的服务与开通进度会显示在这里。</p>
            <div className="cc-svc-notice-actions">
              <Link className="cc-svc-primary" to="/subscribe">前往套餐订阅</Link>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  const openCount = items.filter((item) => item.serviceStatus === "open").length;
  const pendingCount = items.length - openCount;

  return (
    <PageFrame>
      <section className="cc-svc-summary" aria-label="服务概览">
        <article>
          <span>服务总数</span>
          <strong>{items.length}</strong>
          <small>来自已支付订单</small>
        </article>
        <article>
          <span>已开通</span>
          <strong>{openCount}</strong>
          <small>已完成人工开通</small>
        </article>
        <article>
          <span>待开通</span>
          <strong>{pendingCount}</strong>
          <small>等待人工开通</small>
        </article>
      </section>

      <section className="cc-svc-panel">
        <PanelHead tag={`共 ${items.length} 项`} />
        <ul className="cc-svc-list">
          {items.map((item) => {
            const isOpen = item.serviceStatus === "open";
            return (
              <li className="cc-svc-item" key={item.orderRef}>
                <div className="cc-svc-item-head">
                  <div className="cc-svc-item-id">
                    <strong>{item.orderRef}</strong>
                    <small>创建于 {formatDate(item.createdAt)}</small>
                  </div>
                  <span className={`cc-svc-badge ${isOpen ? "is-open" : "is-pending"}`}>
                    {serviceStatusLabel(item.serviceStatus)}
                  </span>
                </div>
                <dl className="cc-svc-facts">
                  <div>
                    <dt>支付金额</dt>
                    <dd>{formatFen(item.amountFen)}</dd>
                  </div>
                  <div>
                    <dt>订单状态</dt>
                    <dd>{ORDER_STATUS_LABEL[item.orderStatus]}</dd>
                  </div>
                  <div>
                    <dt>服务状态</dt>
                    <dd>{serviceStatusLabel(item.serviceStatus)}</dd>
                  </div>
                </dl>
                <div className="cc-svc-item-foot">
                  <p>{isOpen ? "服务已完成人工开通。" : "服务正在等待人工开通，请留意状态更新。"}</p>
                </div>
                {isOpen && <ServiceSubscription item={item} />}
                {!isOpen && <p className="cc-svc-import-state">等待人工交付，订阅信息暂未提供。</p>}
              </li>
            );
          })}
        </ul>
      </section>
    </PageFrame>
  );
}

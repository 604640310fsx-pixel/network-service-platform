import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyOrders,
  getMyServices,
  type MyOrderItem,
  type MyServiceItem,
  type PaymentOrderStatus,
  type ServiceStatus,
} from "../../lib/payment-api";

type ResourceState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

const ORDER_STATUS_LABEL: Record<PaymentOrderStatus, string> = {
  pending: "待支付",
  paid: "已支付",
  closed: "已关闭",
};

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

function serviceStatusLabel(status: ServiceStatus | null): string {
  if (status === null) return "无服务";
  return status === "open" ? "已开通" : "待开通";
}

function resourceErrorMessage(resource: "服务" | "订单", error: unknown): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return `${resource}数据返回异常，请稍后重试。`;
  }
  return `暂时无法读取${resource}状态，请稍后重试。`;
}

function stateHint<T>(state: ResourceState<T>, readyHint: string): string {
  if (state.kind === "loading") return "正在读取";
  if (state.kind === "unauthorized") return "登录已失效";
  if (state.kind === "error") return "读取失败";
  return readyHint;
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="dash-service" role="status" aria-live="polite" aria-busy="true">
      <div className="dash-service-head">
        <div><strong>—</strong><small>正在读取{label}状态</small></div>
        <span className="dash-tag">加载中</span>
      </div>
    </div>
  );
}

function UnauthorizedCard({ label }: { label: string }) {
  return (
    <div className="dash-service" role="alert">
      <div className="dash-service-head">
        <div><strong>—</strong><small>登录状态已失效，重新登录后可查看{label}。</small></div>
        <span className="dash-tag">登录失效</span>
      </div>
      <div className="dash-service-foot">
        <a className="dash-primary-link" href="/login">重新登录</a>
      </div>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="dash-service" role="alert">
      <div className="dash-service-head">
        <div><strong>—</strong><small>{message}</small></div>
        <span className="dash-tag">读取失败</span>
      </div>
      <div className="dash-service-foot">
        <button type="button" className="dash-primary-link" onClick={onRetry}>重新加载</button>
      </div>
    </div>
  );
}

function CurrentServiceCard({
  state,
  onRetry,
}: {
  state: ResourceState<readonly MyServiceItem[]>;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <LoadingCard label="服务" />;
  if (state.kind === "unauthorized") return <UnauthorizedCard label="服务与开通进度" />;
  if (state.kind === "error") return <ErrorCard message={state.message} onRetry={onRetry} />;

  const current = [...state.items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  if (current === null) {
    return (
      <div className="dash-service">
        <div className="dash-service-head">
          <div><strong>暂无服务</strong><small>完成付款后，可在这里查看服务开通进度。</small></div>
          <span className="dash-tag">0 项</span>
        </div>
        <div className="dash-service-foot">
          <Link className="dash-primary-link" to="/subscribe">前往套餐订阅</Link>
        </div>
      </div>
    );
  }

  const isOpen = current.serviceStatus === "open";
  return (
    <div className="dash-service dash-buyer-card">
      <div className="dash-service-head">
        <div><strong>{current.orderRef}</strong><small>最近一项已支付服务</small></div>
        <span className={`dash-tag ${isOpen ? "is-accent" : ""}`}>{serviceStatusLabel(current.serviceStatus)}</span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>支付金额</dt><dd>{formatFen(current.amountFen)}</dd></div>
        <div><dt>创建时间</dt><dd>{formatDate(current.createdAt)}</dd></div>
        <div><dt>订单状态</dt><dd>{ORDER_STATUS_LABEL[current.orderStatus]}</dd></div>
        <div><dt>服务状态</dt><dd>{serviceStatusLabel(current.serviceStatus)}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>{isOpen ? "服务已完成人工开通。" : "服务正在等待人工开通，请留意状态更新。"}</p>
        <Link className="dash-secondary-link" to="/services">查看全部服务</Link>
      </div>
    </div>
  );
}

function RecentOrderCard({
  state,
  onRetry,
}: {
  state: ResourceState<readonly MyOrderItem[]>;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <LoadingCard label="订单" />;
  if (state.kind === "unauthorized") return <UnauthorizedCard label="订单" />;
  if (state.kind === "error") return <ErrorCard message={state.message} onRetry={onRetry} />;

  const current = state.items[0] ?? null;
  if (current === null) {
    return (
      <div className="dash-service">
        <div className="dash-service-head">
          <div><strong>暂无订单</strong><small>选择套餐并提交需求后，订单会显示在这里。</small></div>
          <span className="dash-tag">0 项</span>
        </div>
        <div className="dash-service-foot">
          <Link className="dash-primary-link" to="/subscribe">选择套餐</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-service dash-buyer-card">
      <div className="dash-service-head">
        <div><strong>{current.orderRef}</strong><small>最近一笔订单</small></div>
        <span className={`dash-tag ${current.status === "paid" ? "is-accent" : ""}`}>
          {ORDER_STATUS_LABEL[current.status]}
        </span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>订单金额</dt><dd>{formatFen(current.amountFen)}</dd></div>
        <div><dt>创建时间</dt><dd>{formatDate(current.createdAt)}</dd></div>
        <div><dt>订单状态</dt><dd>{ORDER_STATUS_LABEL[current.status]}</dd></div>
        <div><dt>服务状态</dt><dd>{serviceStatusLabel(current.serviceStatus)}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>订单与付款状态均来自当前账户的真实订单记录。</p>
        <Link className="dash-secondary-link" to="/orders">查看全部订单</Link>
      </div>
    </div>
  );
}

/* 概览下方的「更多」列表：只展示已读取到的真实条目，作为特写卡之后的第二层级。 */
function MoreList({
  title,
  items,
  to,
  linkLabel,
}: {
  title: string;
  items: readonly {
    readonly key: string;
    readonly orderRef: string;
    readonly meta: string;
    readonly badge: string;
    readonly accent: boolean;
  }[];
  to: string;
  linkLabel: string;
}) {
  return (
    <div className="dash-more">
      <div className="dash-more-head">
        <strong>{title}</strong>
        <Link to={to}>{linkLabel}</Link>
      </div>
      <ul className="dash-more-list">
        {items.map((item) => (
          <li key={item.key}>
            <div>
              <strong>{item.orderRef}</strong>
              <small>{item.meta}</small>
            </div>
            <span className={`dash-tag ${item.accent ? "is-accent" : ""}`}>{item.badge}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NetworkIcon({ kind }: { kind: "nodes" | "monitor" }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "aria-hidden": true } as const;
  if (kind === "nodes") {
    return <svg {...common}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" /></svg>;
  }
  return <svg {...common}><path d="M4 17l4-4 3 2 6-7 3 3" /><path d="M16 8h4v4" /></svg>;
}

export function BuyerDashboardOverview() {
  const [servicesState, setServicesState] = useState<ResourceState<readonly MyServiceItem[]>>({ kind: "loading" });
  const [ordersState, setOrdersState] = useState<ResourceState<readonly MyOrderItem[]>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setServicesState({ kind: "loading" });
    setOrdersState({ kind: "loading" });

    void getMyServices(controller.signal)
      .then((items) => {
        if (!stopped) setServicesState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setServicesState({ kind: "unauthorized" });
          return;
        }
        setServicesState({ kind: "error", message: resourceErrorMessage("服务", error) });
      });

    void getMyOrders(controller.signal)
      .then((items) => {
        if (!stopped) setOrdersState({ kind: "ready", items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setOrdersState({ kind: "unauthorized" });
          return;
        }
        setOrdersState({ kind: "error", message: resourceErrorMessage("订单", error) });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  const services = servicesState.kind === "ready" ? servicesState.items : null;
  const orders = ordersState.kind === "ready" ? ordersState.items : null;
  const openCount = services?.filter((item) => item.serviceStatus === "open").length ?? null;
  const pendingCount = services === null || openCount === null ? null : services.length - openCount;
  const unpaidCount = orders?.filter((item) => item.status === "pending").length ?? null;
  const reload = () => setReloadToken((token) => token + 1);

  // 特写卡展示最近一项，其余最多三项进入「更多」列表，形成概览 → 特写 → 列表的层级。
  // 与 CurrentServiceCard 同一比较器，保证特写项与列表项不重复。
  const sortedServices: readonly MyServiceItem[] =
    services === null ? [] : [...services].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const extraServices = sortedServices.slice(1, 4).map((item) => ({
    key: item.orderRef,
    orderRef: item.orderRef,
    meta: `${formatDate(item.createdAt)} · ${formatFen(item.amountFen)}`,
    badge: serviceStatusLabel(item.serviceStatus),
    accent: item.serviceStatus === "open",
  }));
  // 订单不在前端重排：后端已按 createdAt DESC 排序。
  const recentOrders: readonly MyOrderItem[] = orders ?? [];
  const extraOrders = recentOrders.slice(1, 4).map((item) => ({
    key: item.orderRef,
    orderRef: item.orderRef,
    meta: `${formatDate(item.createdAt)} · ${formatFen(item.amountFen)}`,
    badge: ORDER_STATUS_LABEL[item.status],
    accent: item.status === "paid",
  }));

  const overviewStats = [
    {
      label: "服务总数",
      value: services === null ? "—" : String(services.length),
      hint: stateHint(servicesState, "已支付服务"),
    },
    {
      label: "已开通",
      value: openCount === null ? "—" : String(openCount),
      hint: stateHint(servicesState, "已完成人工开通"),
    },
    {
      label: "待开通",
      value: pendingCount === null ? "—" : String(pendingCount),
      hint: stateHint(servicesState, "等待人工开通"),
    },
    {
      label: "订单总数",
      value: orders === null ? "—" : String(orders.length),
      hint: stateHint(ordersState, "全部订单"),
    },
    {
      label: "待支付",
      value: unpaidCount === null ? "—" : String(unpaidCount),
      hint: stateHint(ordersState, "等待付款"),
    },
  ] as const;

  return (
    <>
      <section className="dash-panel" aria-labelledby="dash-overview-title">
        <h2 id="dash-overview-title"><em>OVERVIEW</em>买家概览<span>账户实时数据</span></h2>
        <div className="dash-stat-grid">
          {overviewStats.map((stat) => (
            <article className="dash-stat" key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small><i aria-hidden="true" />{stat.hint}</small>
            </article>
          ))}
        </div>
      </section>

      <div className="dash-split">
        <section className="dash-panel" aria-labelledby="dash-service-title">
          <h2 id="dash-service-title">
            <em>SERVICE</em>当前服务
            {services !== null && <span>共 {services.length} 项</span>}
          </h2>
          <CurrentServiceCard state={servicesState} onRetry={reload} />
          {extraServices.length > 0 && (
            <MoreList title="更早的服务" items={extraServices} to="/services" linkLabel="查看全部服务" />
          )}
        </section>

        <section className="dash-panel" aria-labelledby="dash-order-title">
          <h2 id="dash-order-title">
            <em>ORDERS</em>最近订单
            {orders !== null && <span>共 {orders.length} 项</span>}
          </h2>
          <RecentOrderCard state={ordersState} onRetry={reload} />
          {extraOrders.length > 0 && (
            <MoreList title="更早的订单" items={extraOrders} to="/orders" linkLabel="查看全部订单" />
          )}
        </section>
      </div>

      <section className="dash-panel" aria-labelledby="dash-network-title">
        <h2 id="dash-network-title"><em>NETWORK</em>节点与网络<span>节点与流量数据待接入</span></h2>
        <div className="dash-network-entry-grid">
          <article className="dash-network-entry">
            <span className="dash-network-icon"><NetworkIcon kind="nodes" /></span>
            <div>
              <strong>买家节点与流量</strong>
              <p>查看节点与流量页面；未提供的在线、超时和用量数据会明确显示为“待接入”。</p>
              <small>当前已开通服务：{openCount === null ? "—" : openCount}</small>
            </div>
            <Link className="dash-secondary-link" to="/network">进入节点与流量</Link>
          </article>
          <article className="dash-network-entry">
            <span className="dash-network-icon"><NetworkIcon kind="monitor" /></span>
            <div>
              <strong>公开实时监控</strong>
              <p>查看三网线路的公开运行状态，与买家账户内的节点与流量页保持独立。</p>
              <small>无需登录即可访问</small>
            </div>
            <Link className="dash-secondary-link" to="/monitor">查看实时监控</Link>
          </article>
        </div>
      </section>
    </>
  );
}

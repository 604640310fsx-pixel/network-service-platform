import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyOrders,
  getMyServiceListing,
  type MyGrantItem,
  type MyOrderItem,
  type PaymentOrderStatus,
  type ServiceStatus,
} from "../../lib/payment-api";
import { useT, type Messages } from "../../lib/i18n";
import { useMyWallet } from "../../lib/useWallet";
import { formatWalletFen, type WalletLoad } from "../../lib/wallet-api";
import { buyerPlanCounts, combineBuyerPlans, type BuyerPlan } from "./buyerPlans";

// 钱包余额卡与其他概览卡同一口径：未就绪一律显示 "—"，提示语说明加载中 / 失败 / 未登录。
function walletHint(state: WalletLoad, readyHint: string, messages: Messages["dashboard"]): string {
  if (state.kind === "loading") return messages.stateLoading;
  if (state.kind === "unauthorized") return messages.stateSignedOut;
  if (state.kind === "error") return messages.stateFailed;
  return readyHint;
}

type ResourceState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

function formatFen(amountFen: number): string {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function serviceStatusLabel(status: ServiceStatus | null, messages: Messages["account"]): string {
  if (status === null) return messages.serviceStatus.none;
  return status === "open" ? messages.serviceStatus.open : messages.serviceStatus.pending;
}

function resourceErrorMessage(resource: string, error: unknown, messages: Messages["dashboard"]): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return messages.resourceInvalid(resource);
  }
  return messages.resourceUnavailable(resource);
}

function stateHint<T>(state: ResourceState<T>, readyHint: string, messages: Messages["dashboard"]): string {
  if (state.kind === "loading") return messages.stateLoading;
  if (state.kind === "unauthorized") return messages.stateSignedOut;
  if (state.kind === "error") return messages.stateFailed;
  return readyHint;
}

function LoadingCard({ label }: { label: string }) {
  const t = useT();
  return (
    <div className="dash-service" role="status" aria-live="polite" aria-busy="true">
      <div className="dash-service-head">
        <div><strong>—</strong><small>{t.dashboard.loadingResource(label)}</small></div>
        <span className="dash-tag">{t.account.loadingTag}</span>
      </div>
    </div>
  );
}

function UnauthorizedCard({ label }: { label: string }) {
  const t = useT();
  return (
    <div className="dash-service" role="alert">
      <div className="dash-service-head">
        <div><strong>—</strong><small>{t.dashboard.signedOutResource(label)}</small></div>
        <span className="dash-tag">{t.account.signedOutTag}</span>
      </div>
      <div className="dash-service-foot">
        <a className="dash-primary-link" href="/login">{t.account.signInAgain}</a>
      </div>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="dash-service" role="alert">
      <div className="dash-service-head">
        <div><strong>—</strong><small>{message}</small></div>
        <span className="dash-tag">{t.account.loadFailedTag}</span>
      </div>
      <div className="dash-service-foot">
        <button type="button" className="dash-primary-link" onClick={onRetry}>{t.account.reload}</button>
      </div>
    </div>
  );
}

function GiftPlanCard({ grant }: { grant: MyGrantItem }) {
  const t = useT();
  const delivered = grant.deliveryStatus === "open";
  return (
    <div className="dash-service dash-buyer-card">
      <div className="dash-service-head">
        <div><strong>{grant.label}</strong><small>{t.dashboard.latestGift}</small></div>
        <span className="dash-tag is-accent">{t.services.gift}</span>
        <span className={`dash-tag ${delivered ? "is-accent" : ""}`}>
          {delivered ? t.dashboard.giftDelivered : t.dashboard.giftAwaitingDelivery}
        </span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>{t.dashboard.giftValue}</dt><dd>{grant.valueFen === null ? "—" : formatFen(grant.valueFen)}</dd></div>
        <div><dt>{t.dashboard.giftStarted}</dt><dd>{formatDate(grant.startsAt, t.account.dateLocale)}</dd></div>
        <div><dt>{t.dashboard.giftEnds}</dt><dd>{grant.endsAt === null ? t.dashboard.giftLongTerm : formatDate(grant.endsAt, t.account.dateLocale)}</dd></div>
        <div><dt>{t.dashboard.deliveryStatus}</dt><dd>{delivered ? t.dashboard.giftDelivered : t.dashboard.giftAwaitingDelivery}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>{delivered ? t.dashboard.giftOpenHint : t.dashboard.giftPendingHint}</p>
        <Link className="dash-secondary-link" to="/services">{t.dashboard.allServices}</Link>
      </div>
    </div>
  );
}

function CurrentServiceCard({
  state,
  onRetry,
}: {
  state: ResourceState<readonly BuyerPlan[]>;
  onRetry: () => void;
}) {
  const t = useT();
  if (state.kind === "loading") return <LoadingCard label={t.dashboard.resources.services} />;
  if (state.kind === "unauthorized") return <UnauthorizedCard label={t.dashboard.resources.serviceProgress} />;
  if (state.kind === "error") return <ErrorCard message={state.message} onRetry={onRetry} />;

  // Plans arrive newest first (combineBuyerPlans); the featured card is the first one.
  const plan = state.items[0] ?? null;
  if (plan === null) {
    return (
      <div className="dash-service">
        <div className="dash-service-head">
          <div><strong>{t.dashboard.noServices}</strong><small>{t.dashboard.noServicesHint}</small></div>
          <span className="dash-tag">{t.account.zeroItems}</span>
        </div>
        <div className="dash-service-foot">
          <Link className="dash-primary-link" to="/subscribe">{t.account.goSubscribe}</Link>
        </div>
      </div>
    );
  }
  if (plan.kind === "grant") return <GiftPlanCard grant={plan.grant} />;

  const current = plan.service;
  const isOpen = current.serviceStatus === "open";
  return (
    <div className="dash-service dash-buyer-card">
      <div className="dash-service-head">
        <div><strong>{current.orderRef}</strong><small>{t.dashboard.latestService}</small></div>
        <span className={`dash-tag ${isOpen ? "is-accent" : ""}`}>{serviceStatusLabel(current.serviceStatus, t.account)}</span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>{t.dashboard.paidAmount}</dt><dd>{formatFen(current.amountFen)}</dd></div>
        <div><dt>{t.dashboard.createdTime}</dt><dd>{formatDate(current.createdAt, t.account.dateLocale)}</dd></div>
        <div><dt>{t.dashboard.orderStatus}</dt><dd>{t.account.orderStatus[current.orderStatus]}</dd></div>
        <div><dt>{t.dashboard.serviceStatus}</dt><dd>{serviceStatusLabel(current.serviceStatus, t.account)}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>{isOpen ? t.dashboard.serviceOpen : t.dashboard.servicePending}</p>
        <Link className="dash-secondary-link" to="/services">{t.dashboard.allServices}</Link>
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
  const t = useT();
  if (state.kind === "loading") return <LoadingCard label={t.dashboard.resources.orders} />;
  if (state.kind === "unauthorized") return <UnauthorizedCard label={t.dashboard.resources.orders} />;
  if (state.kind === "error") return <ErrorCard message={state.message} onRetry={onRetry} />;

  const current = state.items[0] ?? null;
  if (current === null) {
    return (
      <div className="dash-service">
        <div className="dash-service-head">
          <div><strong>{t.dashboard.noOrders}</strong><small>{t.dashboard.noOrdersHint}</small></div>
          <span className="dash-tag">{t.account.zeroItems}</span>
        </div>
        <div className="dash-service-foot">
          <Link className="dash-primary-link" to="/subscribe">{t.account.choosePlan}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-service dash-buyer-card">
      <div className="dash-service-head">
        <div><strong>{current.orderRef}</strong><small>{t.dashboard.latestOrder}</small></div>
        <span className={`dash-tag ${current.status === "paid" ? "is-accent" : ""}`}>
          {t.account.orderStatus[current.status]}
        </span>
      </div>
      <dl className="dash-service-facts">
        <div><dt>{t.dashboard.orderAmount}</dt><dd>{formatFen(current.amountFen)}</dd></div>
        <div><dt>{t.dashboard.createdTime}</dt><dd>{formatDate(current.createdAt, t.account.dateLocale)}</dd></div>
        <div><dt>{t.dashboard.orderStatus}</dt><dd>{t.account.orderStatus[current.status]}</dd></div>
        <div><dt>{t.dashboard.serviceStatus}</dt><dd>{serviceStatusLabel(current.serviceStatus, t.account)}</dd></div>
      </dl>
      <div className="dash-service-foot">
        <p>{t.dashboard.ordersFromAccount}</p>
        <Link className="dash-secondary-link" to="/orders">{t.dashboard.allOrders}</Link>
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
    readonly title: string;
    readonly meta: string;
    readonly badge: string;
    readonly accent: boolean;
    /** Text of a gift tag shown before the status badge; absent for purchases and orders. */
    readonly gift?: string;
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
              <strong>{item.title}</strong>
              <small>{item.meta}</small>
            </div>
            {item.gift !== undefined && <span className="dash-tag is-accent dash-more-gift">{item.gift}</span>}
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
  const t = useT();
  const [servicesState, setServicesState] = useState<ResourceState<readonly BuyerPlan[]>>({ kind: "loading" });
  const [ordersState, setOrdersState] = useState<ResourceState<readonly MyOrderItem[]>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const wallet = useMyWallet(reloadToken);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setServicesState({ kind: "loading" });
    setOrdersState({ kind: "loading" });

    void getMyServiceListing(controller.signal)
      .then(({ services, grants }) => {
        if (!stopped) setServicesState({ kind: "ready", items: combineBuyerPlans(services, grants) });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setServicesState({ kind: "unauthorized" });
          return;
        }
        setServicesState({ kind: "error", message: resourceErrorMessage(t.dashboard.resources.services, error, t.dashboard) });
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
        setOrdersState({ kind: "error", message: resourceErrorMessage(t.dashboard.resources.orders, error, t.dashboard) });
      });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadToken]);

  const plans = servicesState.kind === "ready" ? servicesState.items : null;
  const orders = ordersState.kind === "ready" ? ordersState.items : null;
  const planCounts = plans === null ? null : buyerPlanCounts(plans);
  const openCount = planCounts?.open ?? null;
  const pendingCount = planCounts?.pending ?? null;
  const unpaidCount = orders?.filter((item) => item.status === "pending").length ?? null;
  const reload = () => setReloadToken((token) => token + 1);

  // 特写卡展示最近一项，其余最多三项进入「更多」列表，形成概览 → 特写 → 列表的层级。
  // 与 CurrentServiceCard 共用 combineBuyerPlans 的顺序，保证特写项与列表项不重复。
  const extraServices = (plans ?? []).slice(1, 4).map((plan) =>
    plan.kind === "purchase"
      ? {
          key: plan.key,
          title: plan.service.orderRef,
          meta: `${formatDate(plan.service.createdAt, t.account.dateLocale)} · ${formatFen(plan.service.amountFen)}`,
          badge: serviceStatusLabel(plan.service.serviceStatus, t.account),
          accent: plan.open,
        }
      : {
          key: plan.key,
          title: plan.grant.label,
          meta: plan.grant.valueFen === null
            ? formatDate(plan.grant.startsAt, t.account.dateLocale)
            : `${formatDate(plan.grant.startsAt, t.account.dateLocale)} · ${formatFen(plan.grant.valueFen)}`,
          badge: plan.open ? t.dashboard.giftDelivered : t.dashboard.giftAwaitingDelivery,
          accent: plan.open,
          gift: t.services.gift,
        },
  );
  // 订单不在前端重排：后端已按 createdAt DESC 排序。
  const recentOrders: readonly MyOrderItem[] = orders ?? [];
  const extraOrders = recentOrders.slice(1, 4).map((item) => ({
    key: item.orderRef,
    title: item.orderRef,
    meta: `${formatDate(item.createdAt, t.account.dateLocale)} · ${formatFen(item.amountFen)}`,
    badge: t.account.orderStatus[item.status],
    accent: item.status === "paid",
  }));

  const overviewStats = [
    {
      label: t.dashboard.stats.services.label,
      value: planCounts === null ? "—" : String(planCounts.total),
      hint: stateHint(servicesState, t.dashboard.stats.services.hint, t.dashboard),
    },
    {
      label: t.dashboard.stats.open.label,
      value: openCount === null ? "—" : String(openCount),
      hint: stateHint(servicesState, t.dashboard.stats.open.hint, t.dashboard),
    },
    {
      label: t.dashboard.stats.pending.label,
      value: pendingCount === null ? "—" : String(pendingCount),
      hint: stateHint(servicesState, t.dashboard.stats.pending.hint, t.dashboard),
    },
    {
      label: t.dashboard.stats.orders.label,
      value: orders === null ? "—" : String(orders.length),
      hint: stateHint(ordersState, t.dashboard.stats.orders.hint, t.dashboard),
    },
    {
      label: t.dashboard.stats.unpaid.label,
      value: unpaidCount === null ? "—" : String(unpaidCount),
      hint: stateHint(ordersState, t.dashboard.stats.unpaid.hint, t.dashboard),
    },
    {
      label: t.wallet.balanceLabel,
      value: wallet.state.kind === "ready" ? formatWalletFen(wallet.state.wallet.balanceFen) : "—",
      hint: walletHint(wallet.state, t.wallet.balanceHint, t.dashboard),
    },
  ] as const;

  return (
    <>
      <section className="dash-panel" aria-labelledby="dash-overview-title">
        <h2 id="dash-overview-title"><em>OVERVIEW</em>{t.dashboard.overviewTitle}<span>{t.dashboard.overviewTag}</span></h2>
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
            <em>SERVICE</em>{t.dashboard.currentService}
            {plans !== null && <span>{t.account.itemCount(plans.length)}</span>}
          </h2>
          <CurrentServiceCard state={servicesState} onRetry={reload} />
          {extraServices.length > 0 && (
            <MoreList title={t.dashboard.earlierServices} items={extraServices} to="/services" linkLabel={t.dashboard.allServices} />
          )}
        </section>

        <section className="dash-panel" aria-labelledby="dash-order-title">
          <h2 id="dash-order-title">
            <em>ORDERS</em>{t.dashboard.recentOrders}
            {orders !== null && <span>{t.account.itemCount(orders.length)}</span>}
          </h2>
          <RecentOrderCard state={ordersState} onRetry={reload} />
          {extraOrders.length > 0 && (
            <MoreList title={t.dashboard.earlierOrders} items={extraOrders} to="/orders" linkLabel={t.dashboard.allOrders} />
          )}
        </section>
      </div>

      <section className="dash-panel" aria-labelledby="dash-network-title">
        <h2 id="dash-network-title"><em>NETWORK</em>{t.dashboard.networkTitle}<span>{t.dashboard.networkTag}</span></h2>
        <div className="dash-network-entry-grid">
          <article className="dash-network-entry">
            <span className="dash-network-icon"><NetworkIcon kind="nodes" /></span>
            <div>
              <strong>{t.dashboard.nodesTitle}</strong>
              <p>{t.dashboard.nodesBody}</p>
              <small>{t.dashboard.nodesOpen}{openCount === null ? "—" : openCount}</small>
            </div>
            <Link className="dash-secondary-link" to="/network">{t.dashboard.nodesLink}</Link>
          </article>
          <article className="dash-network-entry">
            <span className="dash-network-icon"><NetworkIcon kind="monitor" /></span>
            <div>
              <strong>{t.dashboard.monitorTitle}</strong>
              <p>{t.dashboard.monitorBody}</p>
              <small>{t.dashboard.monitorNoLogin}</small>
            </div>
            <Link className="dash-secondary-link" to="/monitor">{t.dashboard.monitorLink}</Link>
          </article>
        </div>
      </section>
    </>
  );
}

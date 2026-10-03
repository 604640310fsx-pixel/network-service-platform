import { useEffect, useState } from "react";
import { useCatalogText, useT, type Messages } from "../../lib/i18n";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getPaymentOrder,
  getMyGrantDelivery,
  getMyServiceListing,
  type MyGrantItem,
  type MyServiceItem,
  type PaymentOrderSnapshot,
  type ServiceDeliveryItem,
  type ServiceStatus,
} from "../../lib/payment-api";
import { resolveSelection } from "../../lib/resolveSelection";
import { serviceTerm } from "../../lib/serviceTerm";
import { SubscriptionImportModule, verifiedSubscriptionDeepLink } from "../subscription-import";
import { buyerPlanCounts, combineBuyerPlans } from "../dashboard/buyerPlans";
import "./customer-services.css";

/* /services 列表只来自 GET /api/me/services；已开通卡片的交付数据按其 orderRef
   独立读取现有授权订单快照，不从仅含线路名称的 delivery-lines 接口推导地址。
   失败或快照与卡片不一致时不展示地址，也不回退 Mock。 */

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyServiceItem[]; readonly grants: readonly MyGrantItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

type DeliveryState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly ServiceDeliveryItem[] }
  | { readonly kind: "error"; readonly message: string };

function serviceStatusLabel(status: ServiceStatus, messages: Messages["account"]): string {
  return status === "open" ? messages.serviceStatus.open : messages.serviceStatus.pending;
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

function formatDay(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date);
}

/* 期限徽标：长期 / 剩余 N 天 / 已到期。到期项保留在列表里，只标为「已到期」。 */
function TermBadge({ endsAt }: { endsAt: string | null }) {
  const t = useT();
  const term = serviceTerm(endsAt, new Date());
  const label =
    term.kind === "long_term" ? t.services.termLongTerm
      : term.kind === "expired" ? t.services.termExpired
        : t.services.termRemaining(term.days);
  return (
    <span
      className={`cc-svc-badge cc-svc-term${term.kind === "expired" ? " is-expired" : ""}`}
      title={endsAt === null ? undefined : t.services.termEndsOn(formatDay(endsAt, t.account.dateLocale))}
    >
      {label}
    </span>
  );
}

function genericErrorMessage(error: unknown, messages: Messages["services"]): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return messages.invalid;
  }
  return messages.unavailable;
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-svc-page">
      <div className="cc-svc-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  const t = useT();
  return (
    <div className="cc-svc-panel-head">
      <div>
        <em>SERVICES</em>
        <h2>{t.services.title}</h2>
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
  const t = useT();
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
          setState({ kind: "error", message: t.services.deliveryMismatch });
          return;
        }
        setState({ kind: "ready", items: deliveryItems });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof PaymentApiError && error.code === "invalid_response"
          ? t.services.deliveryInvalid
          : t.services.subscriptionUnavailable;
        setState({ kind: "error", message });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [item.orderRef, item.orderStatus, item.amountFen, item.currency, item.serviceStatus, retryToken]);

  return (
    <section className="cc-svc-import" aria-label={t.services.subscriptionLabel(item.orderRef)}>
      {state.kind === "loading" && (
        <p className="cc-svc-import-state" role="status">{t.services.subscriptionLoading}</p>
      )}
      {state.kind === "error" && (
        <div className="cc-svc-import-state" role="alert">
          <p>{state.message}</p>
          <button type="button" className="cc-svc-ghost" onClick={() => setRetryToken((token) => token + 1)}>
            {t.services.retryRead}
          </button>
        </div>
      )}
      {state.kind === "ready" && (
        <SubscriptionImportModule
          deliveryItems={state.items}
          compact
          getVerifiedDeepLink={verifiedSubscriptionDeepLink}
        />
      )}
      <div className="cc-svc-import-links">
        <Link to="/docs">{t.services.importGuide}</Link>
        <Link to={`/subscribe/request?orderRef=${encodeURIComponent(item.orderRef)}`}>{t.services.orderDetails}</Link>
      </div>
    </section>
  );
}

function formatYuan(fen: number): string {
  const amount = fen / 100;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/* 赠送套餐详情：目录 id 由前端译成当前语言的名称；022 时代的旧赠送没有这些字段，只显示名称与赠送徽标。 */
function GiftDetails({ grant }: { grant: MyGrantItem }) {
  const t = useT();
  const catalogText = useCatalogText();
  const parts: string[] = [];
  if (grant.typeId && grant.regionId && grant.ispId && grant.durationId) {
    const { summary, requiresSpec } = resolveSelection({
      typeId: grant.typeId,
      regionId: grant.regionId,
      ispId: grant.ispId,
      specId: grant.specId,
      durationId: grant.durationId,
    });
    for (const part of [summary.type, summary.region, summary.isp, ...(requiresSpec ? [summary.spec] : [])]) {
      if (part && part !== "—") parts.push(catalogText(part));
    }
  }
  if (grant.months !== null) parts.push(t.services.giftMonths(grant.months));
  if (grant.valueFen !== null) parts.push(t.services.giftValue(formatYuan(grant.valueFen)));
  return parts.length > 0 ? <small className="cc-svc-gift-details">{parts.join(" · ")}</small> : null;
}

/* 已开通的赠送：订阅地址只从买家本人的 /api/me/grants/:id/delivery 读取（与已购服务读取订单快照同理）。 */
function GiftSubscription({ grant }: { grant: MyGrantItem }) {
  const t = useT();
  const [state, setState] = useState<DeliveryState>({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyGrantDelivery(grant.grantId, controller.signal)
      .then((delivery) => {
        if (!stopped) setState({ kind: "ready", items: delivery.items });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof PaymentApiError && error.code === "invalid_response"
          ? t.services.deliveryInvalid
          : t.services.subscriptionUnavailable;
        setState({ kind: "error", message });
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [grant.grantId, retryToken]);

  return (
    <section className="cc-svc-import" aria-label={t.services.giftSubscriptionLabel(grant.label)}>
      {state.kind === "loading" && <p className="cc-svc-import-state" role="status">{t.services.subscriptionLoading}</p>}
      {state.kind === "error" && (
        <div className="cc-svc-import-state" role="alert">
          <p>{state.message}</p>
          <button type="button" className="cc-svc-ghost" onClick={() => setRetryToken((token) => token + 1)}>
            {t.services.retryRead}
          </button>
        </div>
      )}
      {state.kind === "ready" && (
        <SubscriptionImportModule deliveryItems={state.items} compact getVerifiedDeepLink={verifiedSubscriptionDeepLink} />
      )}
      <div className="cc-svc-import-links">
        <Link to="/docs">{t.services.importGuide}</Link>
      </div>
    </section>
  );
}

export function CustomerServicesPage() {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ kind: "loading" });
    void getMyServiceListing(controller.signal)
      .then(({ services, grants }) => {
        if (stopped) return;
        setState({ kind: "ready", items: services, grants });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (error instanceof PaymentApiError && error.code === "unauthorized") {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: genericErrorMessage(error, t.services) });
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
          <PanelHead tag={t.account.loadingTag} />
          <ul className="cc-svc-skeleton" aria-hidden="true">
            <li /><li /><li />
          </ul>
          <p className="cc-svc-status-text">{t.services.loading}</p>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <PageFrame>
        <section className="cc-svc-panel" role="alert">
          <PanelHead tag={t.account.signedOutTag} />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">{t.account.signedOut}</p>
            <p className="cc-svc-notice-hint">{t.services.signedOutHint}</p>
            <div className="cc-svc-notice-actions">
              {/* 会话失效恢复：必须整页导航而非 SPA Link。AuthProvider 仅在首次挂载时
                  检查 /api/auth/me，之后 /api/me/services 的 401 不会把 status 从
                  authenticated 降级；用 <Link> 时 LoginRoute 会读到旧的 authenticated
                  并立即重定向回 /dashboard。原生 <a> 触发整页加载，强制重新检查会话。 */}
              <a className="cc-svc-primary" href="/login">{t.account.signInAgain}</a>
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
          <PanelHead tag={t.account.loadFailedTag} />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">{state.message}</p>
            <p className="cc-svc-notice-hint">{t.services.retryHint}</p>
            <div className="cc-svc-notice-actions">
              <button
                type="button"
                className="cc-svc-primary"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                {t.account.reload}
              </button>
              <Link className="cc-svc-ghost" to="/subscribe">{t.account.goSubscribe}</Link>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  const { items, grants } = state;
  if (items.length === 0 && grants.length === 0) {
    return (
      <PageFrame>
        <section className="cc-svc-panel">
          <PanelHead tag={t.services.emptyTag} />
          <div className="cc-svc-notice">
            <p className="cc-svc-notice-title">{t.services.empty}</p>
            <p className="cc-svc-notice-hint">{t.services.emptyHint}</p>
            <div className="cc-svc-notice-actions">
              <Link className="cc-svc-primary" to="/subscribe">{t.account.goSubscribe}</Link>
            </div>
          </div>
        </section>
      </PageFrame>
    );
  }

  // 与仪表板同一计数口径：已购服务 + 有效赠送合并计数（buyerPlans.ts）。
  const counts = buyerPlanCounts(combineBuyerPlans(items, grants));

  return (
    <PageFrame>
      <section className="cc-svc-summary" aria-label={t.services.summaryLabel}>
        <article>
          <span>{t.services.total}</span>
          <strong>{counts.total}</strong>
          <small>{t.services.totalHint}</small>
        </article>
        <article>
          <span>{t.services.open}</span>
          <strong>{counts.open}</strong>
          <small>{t.services.openHint}</small>
        </article>
        <article>
          <span>{t.services.pending}</span>
          <strong>{counts.pending}</strong>
          <small>{t.services.pendingHint}</small>
        </article>
      </section>

      <section className="cc-svc-panel">
        <PanelHead tag={t.account.itemCount(counts.total)} />
        <ul className="cc-svc-list">
          {items.map((item) => {
            const isOpen = item.serviceStatus === "open";
            return (
              <li className="cc-svc-item" key={item.orderRef}>
                <div className="cc-svc-item-head">
                  <div className="cc-svc-item-id">
                    <strong>{item.planLabel ?? item.orderRef}</strong>
                    {item.planLabel !== null && <small>{t.services.orderRefLabel(item.orderRef)}</small>}
                    <small>{t.account.createdAt(formatDate(item.createdAt, t.account.dateLocale))}</small>
                  </div>
                  <div className="cc-svc-badges">
                    <span className={`cc-svc-badge ${isOpen ? "is-open" : "is-pending"}`}>
                      {serviceStatusLabel(item.serviceStatus, t.account)}
                    </span>
                    <TermBadge endsAt={item.endsAt} />
                  </div>
                </div>
                {!isOpen && (
                  <div className="cc-svc-item-foot">
                    <p>{t.services.pendingNotice}</p>
                  </div>
                )}
                {isOpen && <ServiceSubscription item={item} />}
                {!isOpen && <p className="cc-svc-import-state">{t.services.awaitingDelivery}</p>}
              </li>
            );
          })}
        </ul>
        {grants.length > 0 && (
          <ul className="cc-svc-list cc-svc-gifts" aria-label={t.services.giftsLabel}>
            {grants.map((grant) => (
              <li className="cc-svc-item is-gift" key={grant.grantId}>
                <div className="cc-svc-item-head">
                  <div className="cc-svc-item-id">
                    <strong>{grant.label}</strong>
                    <GiftDetails grant={grant} />
                    <small>{t.services.giftStartedAt(formatDate(grant.startsAt, t.account.dateLocale))}</small>
                  </div>
                  <div className="cc-svc-badges">
                    <span className="cc-svc-badge is-gift">{t.services.gift}</span>
                    <TermBadge endsAt={grant.endsAt} />
                  </div>
                </div>
                {grant.deliveryStatus === "open"
                  ? <GiftSubscription grant={grant} />
                  : <p className="cc-svc-import-state">{grant.typeId === null ? t.services.giftHint : t.services.giftAwaiting}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageFrame>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PaymentApiError,
  getMyOrders,
  type MyOrderItem,
  type PaymentOrderStatus,
  type ServiceStatus,
} from "../../lib/payment-api";
import { useT, type Messages } from "../../lib/i18n";
import { useAuth } from "../../lib/auth";
import { WalletApiError, cancelMyOrder } from "../../lib/wallet-api";
import "./customer-orders.css";

/* 未付款订单取消（后端 f1e0898 POST /api/me/orders/:orderRef/cancel）：两步确认；结果只按服务端
   result 显示，并重新读取订单列表。已付 409 not_cancellable 时刷新列表；失败不改本地状态。 */
function CancelUnpaidOrder({ orderRef, onDone }: { orderRef: string; onDone: (message: string) => void }) {
  const copy = useT().wallet.orderCancel;
  const { csrfToken } = useAuth();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmCancel() {
    if (csrfToken === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cancelMyOrder(csrfToken, orderRef);
      onDone(result === "CANCELLED" ? copy.cancelled(orderRef) : copy.alreadyCancelled(orderRef));
    } catch (cancelError) {
      const code = cancelError instanceof WalletApiError ? cancelError.code : "";
      if (code === "not_cancellable") {
        onDone(copy.notCancellable);
        return;
      }
      setError(
        code === "unauthorized" ? copy.errors.unauthorized
          : code === "csrf_invalid" ? copy.errors.csrfInvalid
            : code === "not_found" ? copy.errors.notFound
              : code === "network_error" ? copy.errors.network
                : copy.errors.unavailable,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!asking) {
    return <button type="button" className="cc-ord-ghost" disabled={csrfToken === null} onClick={() => setAsking(true)}>{copy.action}</button>;
  }
  return (
    <div className="cc-ord-cancel" role="group" aria-label={copy.action}>
      <span className="cc-ord-cancel-prompt">{copy.prompt}</span>
      <button type="button" className="cc-ord-ghost cc-ord-cancel-confirm" disabled={busy} aria-busy={busy} onClick={() => void confirmCancel()}>
        {busy ? copy.cancelling : copy.confirm}
      </button>
      <button type="button" className="cc-ord-ghost" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>{copy.keep}</button>
      {error && <p className="cc-ord-cancel-error" role="alert">{error}</p>}
    </div>
  );
}

/* /orders 客户中心「订单」页：数据只来自 GET /api/me/orders（listMyOrders），
   仅展示公共契约允许的客户字段。不展示 contact / notes / scenarios / tradeNo /
   outTradeNo / paymentId / serviceId / userId / token / 内部资源；失败一律真实错误态，
   绝不回退硬编码 / Mock 数据。列表不在前端重排，保持后端排序。 */

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly MyOrderItem[] }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string };

const ORDER_STATUS_MODIFIER: Record<PaymentOrderStatus, string> = {
  pending: "is-pending",
  paid: "is-paid",
  closed: "is-closed",
};

function serviceStatusLabel(status: ServiceStatus | null, messages: Messages["account"]): string {
  if (status === null) return messages.serviceStatus.none;
  return status === "open" ? messages.serviceStatus.open : messages.serviceStatus.pending;
}

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

function genericErrorMessage(error: unknown, messages: Messages["orders"]): string {
  if (error instanceof PaymentApiError && error.code === "invalid_response") {
    return messages.invalid;
  }
  return messages.unavailable;
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cc-ord-page">
      <div className="cc-ord-layout">{children}</div>
    </main>
  );
}

function PanelHead({ tag }: { tag: string }) {
  const t = useT();
  return (
    <div className="cc-ord-panel-head">
      <div>
        <em>ORDERS</em>
        <h2>{t.orders.title}</h2>
      </div>
      <span className="cc-ord-tag">{tag}</span>
    </div>
  );
}

export function CustomerOrdersPage() {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  function afterCancel(message: string) {
    setNotice(message);
    setReloadToken((token) => token + 1);
  }

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
        setState({ kind: "error", message: genericErrorMessage(error, t.orders) });
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
          <PanelHead tag={t.account.loadingTag} />
          <ul className="cc-ord-skeleton" aria-hidden="true">
            <li /><li /><li />
          </ul>
          <p className="cc-ord-status-text">{t.orders.loading}</p>
        </section>
      </PageFrame>
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <PageFrame>
        <section className="cc-ord-panel" role="alert">
          <PanelHead tag={t.account.signedOutTag} />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">{t.account.signedOut}</p>
            <p className="cc-ord-notice-hint">{t.orders.signedOutHint}</p>
            <div className="cc-ord-notice-actions">
              {/* 会话失效恢复：必须整页导航而非 SPA Link。AuthProvider 仅在首次挂载时
                  检查 /api/auth/me，之后 /api/me/orders 的 401 不会把 status 从
                  authenticated 降级；用 <Link> 时 LoginRoute 会读到旧的 authenticated
                  并立即重定向回 /dashboard。原生 <a> 触发整页加载，强制重新检查会话。 */}
              <a className="cc-ord-primary" href="/login">{t.account.signInAgain}</a>
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
          <PanelHead tag={t.account.loadFailedTag} />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">{state.message}</p>
            <p className="cc-ord-notice-hint">{t.orders.retryHint}</p>
            <div className="cc-ord-notice-actions">
              <button
                type="button"
                className="cc-ord-primary"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                {t.account.reload}
              </button>
              <Link className="cc-ord-ghost" to="/subscribe">{t.account.goSubscribe}</Link>
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
          <PanelHead tag={t.orders.emptyTag} />
          <div className="cc-ord-notice">
            <p className="cc-ord-notice-title">{t.orders.empty}</p>
            <p className="cc-ord-notice-hint">{t.orders.emptyHint}</p>
            <div className="cc-ord-notice-actions">
              <Link className="cc-ord-primary" to="/subscribe">{t.account.choosePlan}</Link>
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
      <section className="cc-ord-summary" aria-label={t.orders.summaryLabel}>
        <article>
          <span>{t.orders.total}</span>
          <strong>{items.length}</strong>
          <small>{t.orders.totalHint}</small>
        </article>
        <article>
          <span>{t.orders.pending}</span>
          <strong>{pendingCount}</strong>
          <small>{t.orders.pendingHint}</small>
        </article>
        <article>
          <span>{t.orders.paid}</span>
          <strong>{paidCount}</strong>
          <small>{t.orders.paidHint}</small>
        </article>
      </section>

      <section className="cc-ord-panel">
        <PanelHead tag={t.account.itemCount(items.length)} />
        {notice && <p className="cc-ord-cancel-notice" role="status">{notice}</p>}
        <ul className="cc-ord-list">
          {items.map((item) => (
            <li className="cc-ord-item" key={item.orderRef}>
              <div className="cc-ord-item-head">
                <div className="cc-ord-item-id">
                  <strong>{item.orderRef}</strong>
                  <small>{t.account.createdAt(formatDate(item.createdAt, t.account.dateLocale))}</small>
                </div>
                <span className={`cc-ord-badge ${ORDER_STATUS_MODIFIER[item.status]}`}>
                  {t.account.orderStatus[item.status]}
                </span>
              </div>

              <dl className="cc-ord-facts">
                <div>
                  <dt>{t.orders.amount}</dt>
                  <dd>{formatFen(item.amountFen)}</dd>
                </div>
                <div>
                  <dt>{t.orders.serviceStatus}</dt>
                  <dd>{serviceStatusLabel(item.serviceStatus, t.account)}</dd>
                </div>
                <div>
                  <dt>{t.orders.region}</dt>
                  <dd>{item.regionId}</dd>
                </div>
                <div>
                  <dt>{t.orders.isp}</dt>
                  <dd>{item.ispId}</dd>
                </div>
                <div>
                  <dt>{t.orders.duration}</dt>
                  <dd>{item.durationId}</dd>
                </div>
                <div>
                  <dt>{t.orders.type}</dt>
                  <dd>{item.specId === null ? item.typeId : `${item.typeId} · ${item.specId}`}</dd>
                </div>
              </dl>

              {item.status === "pending" && item.reservedUntil !== null && (
                <p className="cc-ord-reserved">
                  <span>{t.orders.reservedUntil}</span>
                  <b>{formatDate(item.reservedUntil, t.account.dateLocale)}</b>
                </p>
              )}

              <div className="cc-ord-item-foot">
                <Link
                  className="cc-ord-ghost"
                  to={`/subscribe/request?orderRef=${encodeURIComponent(item.orderRef)}`}
                >
                  {t.orders.viewStatus}
                </Link>
                {item.status === "pending" && <CancelUnpaidOrder orderRef={item.orderRef} onDone={afterCancel} />}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </PageFrame>
  );
}

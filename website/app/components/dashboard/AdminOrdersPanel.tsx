import { useEffect, useId, useState, type FormEvent } from "react";
import { closeAdminOrder, listAdminOrders, type AdminOrder, type AdminOrderFilter, type AdminOrderPage } from "../../lib/admin-orders-api";
import { useT, type Messages } from "../../lib/i18n";
import { WalletApiError, formatWalletFen } from "../../lib/wallet-api";

/* 管理员订单管理（后端 078231c）：只读列出全部订单，并对未管理关闭的订单提供内部关单。
   订单状态、支付状态、管理关闭、退款案、停止请求分别显示：无支付记录不等于未付款；
   AWAITING_POLICY 只是待定退款案，REQUESTED 只是已记录停止请求，都不代表已完成。
   读取失败显示错误，不显示空列表；关单结果只按服务端返回显示，并重新读取当前页。 */

type Copy = Messages["wallet"]["adminOrders"];

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly page: AdminOrderPage }
  | { readonly kind: "error"; readonly message: string };

function errorText(error: unknown, copy: Copy): string {
  const code = error instanceof WalletApiError ? error.code : "";
  switch (code) {
    case "unauthorized":
      return copy.errors.unauthorized;
    case "forbidden":
      return copy.errors.forbidden;
    case "csrf_invalid":
      return copy.errors.csrfInvalid;
    case "not_found":
      return copy.errors.notFound;
    case "not_cancellable":
      return copy.errors.notCancellable;
    case "invalid_request":
      return copy.errors.invalidRequest;
    case "network_error":
      return copy.errors.network;
    default:
      return copy.errors.unavailable;
  }
}

function OrderRow({ order, csrfToken, copy, onClosed }: { order: AdminOrder; csrfToken: string | null; copy: Copy; onClosed: (message: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmClose() {
    if (csrfToken === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await closeAdminOrder(csrfToken, order.id);
      const parts = [copy.closed(result.orderRef)];
      if (result.refundState === "AWAITING_POLICY") parts.push(copy.closedRefund);
      if (result.serviceStopState === "REQUESTED") parts.push(copy.closedStop);
      onClosed(parts.join(" "));
    } catch (closeError) {
      setError(errorText(closeError, copy));
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = (value: string) => copy.statuses[value] ?? value;
  return (
    <article className="dash-service">
      <div className="dash-service-head">
        <div>
          <strong>{order.orderRef}</strong>
          <small>{order.createdAt}</small>
        </div>
        <span className={`dash-tag${order.status === "paid" ? " is-accent" : ""}`}>{statusLabel(order.status)}</span>
        {order.managementClosed && <span className="dash-tag">{copy.managementClosed}</span>}
      </div>
      <dl className="dash-service-facts">
        <div><dt>{copy.orderId}</dt><dd>#{order.id}</dd></div>
        <div><dt>{copy.userId}</dt><dd>{order.userId === null ? copy.noUser : `#${order.userId}`}</dd></div>
        <div><dt>{copy.amount}</dt><dd>{formatWalletFen(order.amountFen)}</dd></div>
        <div><dt>{copy.orderStatus}</dt><dd>{statusLabel(order.status)}</dd></div>
        <div><dt>{copy.paymentStatus}</dt><dd>{order.paymentStatus === null ? copy.noPayment : statusLabel(order.paymentStatus)}</dd></div>
        <div>
          <dt>{copy.service}</dt>
          <dd>{order.serviceId === null ? copy.noService : `#${order.serviceId} · ${order.serviceStatus === null ? "—" : copy.serviceStatuses[order.serviceStatus] ?? order.serviceStatus}`}</dd>
        </div>
        <div><dt>{copy.managementClosed}</dt><dd>{order.managementClosed ? copy.yes : copy.no}</dd></div>
        <div><dt>{copy.refundCase}</dt><dd>{order.refundState === null ? copy.none : order.refundState === "AWAITING_POLICY" ? copy.refundAwaiting : order.refundState}</dd></div>
        <div><dt>{copy.stopRequest}</dt><dd>{order.serviceStopState === null ? copy.none : order.serviceStopState === "REQUESTED" ? copy.stopRequested : order.serviceStopState}</dd></div>
      </dl>
      {!order.managementClosed && (
        <div className="dash-coupon-controls">
          {!asking ? (
            <button type="button" disabled={csrfToken === null} onClick={() => setAsking(true)}>{copy.close}</button>
          ) : (
            <>
              <p className="dash-order-close-prompt">{copy.closePrompt}</p>
              <button type="button" disabled={busy} aria-busy={busy} onClick={() => void confirmClose()}>{busy ? copy.closing : copy.closeConfirm}</button>
              <button type="button" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>{copy.closeCancel}</button>
            </>
          )}
        </div>
      )}
      {error && <p className="dash-inline-error" role="alert">{error}</p>}
    </article>
  );
}

export function AdminOrdersPanel({ csrfToken }: { csrfToken: string | null }) {
  const copy = useT().wallet.adminOrders;
  const refId = useId();
  const userIdField = useId();
  const [refInput, setRefInput] = useState("");
  const [userInput, setUserInput] = useState("");
  const [filter, setFilter] = useState<AdminOrderFilter>({});
  const [cursors, setCursors] = useState<readonly number[]>([]);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const beforeId = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void listAdminOrders(beforeId === undefined ? filter : { ...filter, beforeId }, controller.signal)
      .then((page) => setState({ kind: "ready", page }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: `${copy.loadFailed} ${errorText(error, copy)}` });
      });
    return () => controller.abort();
  }, [filter, beforeId, reloadToken]);

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    const next: { orderRef?: string; userId?: number } = {};
    const ref = refInput.trim();
    const user = userInput.trim();
    if (ref !== "") {
      if (ref.length > 128) return setFormError(copy.errors.invalidRequest);
      next.orderRef = ref;
    }
    if (user !== "") {
      const id = Number(user);
      if (!/^[0-9]+$/.test(user) || !Number.isSafeInteger(id) || id <= 0) return setFormError(copy.errors.invalidRequest);
      next.userId = id;
    }
    setFormError(null);
    setNotice(null);
    setCursors([]);
    setFilter(next);
  }

  function resetFilter() {
    setRefInput("");
    setUserInput("");
    setFormError(null);
    setNotice(null);
    setCursors([]);
    setFilter({});
  }

  return (
    <section className="dash-panel" aria-labelledby="dash-admin-orders-title">
      <h2 id="dash-admin-orders-title"><em>ORDERS</em>{copy.title}<span>{copy.tag}</span></h2>
      <p className="dash-order-intro">{copy.intro}</p>
      <form className="dash-coupon-create-grid dash-ticket-filter" onSubmit={applyFilter}>
        <label htmlFor={refId}>{copy.orderRefLabel}<input id={refId} type="text" maxLength={128} value={refInput} onChange={(event) => setRefInput(event.target.value)} /></label>
        <label htmlFor={userIdField}>{copy.userIdLabel}<input id={userIdField} type="text" inputMode="numeric" value={userInput} onChange={(event) => setUserInput(event.target.value)} /></label>
        <div className="dash-coupon-controls">
          <button type="submit">{copy.search}</button>
          <button type="button" onClick={resetFilter}>{copy.reset}</button>
        </div>
      </form>
      {formError && <p className="dash-inline-error" role="alert">{formError}</p>}
      {notice && <p className="dash-order-notice" role="status">{notice}</p>}
      {state.kind === "loading" && <p className="dash-ticket-loading" role="status">{copy.loading}</p>}
      {state.kind === "error" && (
        <div className="dash-coupon-controls" role="alert">
          <p className="dash-inline-error">{state.message}</p>
          <button type="button" onClick={() => setReloadToken((token) => token + 1)}>{copy.retry}</button>
        </div>
      )}
      {state.kind === "ready" && state.page.orders.length === 0 && <p className="dash-ticket-loading">{copy.empty}</p>}
      {state.kind === "ready" && state.page.orders.length > 0 && (
        <div className="dash-admin-list">
          {state.page.orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              csrfToken={csrfToken}
              copy={copy}
              onClosed={(message) => {
                setNotice(message);
                setReloadToken((token) => token + 1);
              }}
            />
          ))}
        </div>
      )}
      {(cursors.length > 0 || (state.kind === "ready" && state.page.nextBeforeId !== null)) && (
        <div className="dash-coupon-controls">
          <button type="button" disabled={cursors.length === 0 || state.kind === "loading"} onClick={() => setCursors([])}>{copy.newest}</button>
          <button
            type="button"
            disabled={state.kind !== "ready" || state.page.nextBeforeId === null}
            onClick={() => state.kind === "ready" && state.page.nextBeforeId !== null && setCursors([...cursors, state.page.nextBeforeId])}
          >
            {copy.older}
          </button>
        </div>
      )}
    </section>
  );
}

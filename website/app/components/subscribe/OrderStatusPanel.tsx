import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "../../lib/auth";
import {
  PaymentApiError,
  bindOrderAccess,
  clearRetryAttempt,
  getOrCreateRetryAttempt,
  getPaymentOrder,
  readOrderAccessToken,
  retryPaymentOrder,
  shouldClearAttemptAfterError,
  type OrderCredentials,
  type PaymentOrderSnapshot,
  type ServiceDeliveryItem,
} from "../../lib/payment-api";

class DeliveryQrBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 订阅链接属于敏感交付数据，不把异常对象或组件栈写入日志。
  }

  render() {
    if (this.state.failed) {
      return <p className="sub-delivery-qr-error" role="alert">二维码生成失败，请复制链接。</p>;
    }
    return this.props.children;
  }
}

function DeliveryItemCard({ item }: { item: ServiceDeliveryItem }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function copySubscriptionUrl() {
    try {
      await navigator.clipboard.writeText(item.subscriptionUrl);
      setCopyMessage("已复制订阅链接");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyMessage("自动复制失败，请手动复制。");
    }
  }

  return (
    <article className="sub-delivery-item">
      <div className="sub-delivery-head">
        <div><small>线路 {item.position}</small><strong>{item.label}</strong></div>
        <span>已交付</span>
      </div>
      <label className="sub-delivery-url">
        <span>订阅链接</span>
        <input ref={inputRef} type="text" value={item.subscriptionUrl} readOnly spellCheck={false} />
      </label>
      <div className="sub-delivery-actions">
        <button type="button" onClick={() => void copySubscriptionUrl()}>复制链接</button>
        <button type="button" aria-expanded={qrOpen} onClick={() => setQrOpen((current) => !current)}>
          {qrOpen ? "收起二维码" : "显示二维码"}
        </button>
        <a href={`clash://install-config?url=${encodeURIComponent(item.subscriptionUrl)}`}>导入到 Clash Verge</a>
      </div>
      {copyMessage !== null && <p className="sub-delivery-message" role="status">{copyMessage}</p>}
      {qrOpen && (
        <div className="sub-delivery-qr">
          <DeliveryQrBoundary>
            <QRCodeSVG value={item.subscriptionUrl} size={184} level="M" marginSize={2} />
          </DeliveryQrBoundary>
        </div>
      )}
    </article>
  );
}

function formatFen(amountFen: number) {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function orderErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法读取订单状态，请稍后重试。";
  switch (error.code) {
    case "not_found":
      return "未找到该订单，或当前浏览器没有有效的查询凭证。";
    case "unauthorized":
      return "请登录下单时使用的账户后查看。";
    case "forbidden":
      return "当前账户无权查看该订单。";
    case "price_changed":
      return error.currentAmountFen === null
        ? "方案价格已变化，请返回方案页重新确认。"
        : `方案价格已更新为 ${formatFen(error.currentAmountFen)}，请返回重新确认。`;
    case "payment_unavailable":
      return "支付服务暂未开放，请稍后再试。";
    case "rate_limited":
      return "查询过于频繁，请稍后再试。";
    case "storage_unavailable":
      return "浏览器无法读取订单查询凭证，请检查本地存储设置。";
    case "network_error":
      return "网络连接失败，请稍后重试。";
    case "invalid_response":
      return "订单状态返回异常，请稍后重试。";
    case "idempotency_key_conflict":
      return "本次重新支付凭证已失效，请再次点击重新支付。";
    default:
      return "暂时无法读取订单状态，请稍后重试。";
  }
}

function canManuallyRetryQuery(error: unknown): boolean {
  if (!(error instanceof PaymentApiError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404) return false;
  return error.code === "network_error" || error.code === "invalid_response" || error.status >= 500;
}

function paymentLabel(status: PaymentOrderSnapshot["status"]) {
  if (status === "paid") return "已支付";
  if (status === "closed") return "已关闭";
  return "等待支付";
}

function serviceLabel(snapshot: PaymentOrderSnapshot) {
  if (snapshot.service?.status === "open") return "已开通";
  if (snapshot.service?.status === "pending_open") return "待开通";
  if (snapshot.status === "paid") return "状态同步中";
  return "—";
}

function statusCopy(snapshot: PaymentOrderSnapshot): { title: string; detail: string } {
  if (snapshot.status === "closed") {
    return { title: "支付已关闭", detail: "本次支付未完成，未生成服务。你可以重新发起付款。" };
  }
  if (snapshot.service?.status === "open") {
    return { title: "服务已开通", detail: "本次服务已完成人工开通。" };
  }
  if (snapshot.service?.status === "pending_open") {
    return { title: "服务待开通", detail: "付款已确认，服务正在等待人工处理。" };
  }
  if (snapshot.status === "paid") {
    return { title: "付款已确认", detail: "服务状态正在同步，请稍候。" };
  }
  return { title: "等待支付确认", detail: "如已完成付款，请稍候；本页会自动更新结果。" };
}

export function OrderStatusPanel({ orderRef }: { orderRef: string }) {
  const navigate = useNavigate();
  const { status: authStatus } = useAuth();
  const [snapshot, setSnapshot] = useState<PaymentOrderSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queryRetryable, setQueryRetryable] = useState(false);
  const [queryGeneration, setQueryGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const accessTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (authStatus === "checking") return;

    let stopped = false;
    let timer: number | null = null;
    const controller = new AbortController();
    setLoading(true);
    setQueryRetryable(false);

    try {
      accessTokenRef.current = readOrderAccessToken(orderRef);
    } catch (storageError) {
      setLoading(false);
      setError(orderErrorMessage(storageError));
      setQueryRetryable(false);
      return () => controller.abort();
    }

    if (authStatus === "unauthenticated" && accessTokenRef.current === null) {
      setLoading(false);
      setError("该订单不在本浏览器；请使用下单时的浏览器，或登录已绑定的账户查看。");
      setQueryRetryable(false);
      return () => controller.abort();
    }

    async function poll() {
      try {
        const next = await getPaymentOrder(orderRef, accessTokenRef.current, controller.signal);
        if (stopped) return;
        setSnapshot(next);
        setLoading(false);
        setError(null);
        setQueryRetryable(false);
        const complete = next.status === "closed" || next.service?.status === "open";
        if (!complete) timer = window.setTimeout(() => void poll(), 5_000);
      } catch (pollError) {
        if (stopped || (pollError instanceof DOMException && pollError.name === "AbortError")) return;
        setLoading(false);
        setError(orderErrorMessage(pollError));
        setQueryRetryable(canManuallyRetryQuery(pollError));
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      controller.abort();
    };
  }, [authStatus, orderRef, queryGeneration]);

  function queryAgain() {
    if (loading) return;
    setError(null);
    setLoading(true);
    setQueryRetryable(false);
    setQueryGeneration((current) => current + 1);
  }

  async function retryPayment() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    setQueryRetryable(false);
    let credentials: OrderCredentials | null = null;
    try {
      credentials = getOrCreateRetryAttempt(orderRef);
      const result = await retryPaymentOrder(orderRef, accessTokenRef.current, credentials);
      bindOrderAccess(result.orderRef, credentials);
      if (result.status === "pending" && result.payUrl !== null) {
        window.location.assign(result.payUrl);
        return;
      }
      navigate(`/subscribe/request?orderRef=${encodeURIComponent(result.orderRef)}`, { replace: true });
    } catch (retryError) {
      if (credentials !== null && shouldClearAttemptAfterError(retryError)) {
        try {
          clearRetryAttempt(credentials);
        } catch {
          // 保留原始请求错误；本地存储不可用时无法额外清理。
        }
      }
      setError(orderErrorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  }

  if (loading && snapshot === null) {
    return (
      <section className="sub-section sub-request-invalid" role="status">
        <h2>正在查询支付结果</h2>
        <p>请稍候，本页不会仅凭跳转结果标记付款成功。</p>
      </section>
    );
  }

  if (snapshot === null) {
    return (
      <section className="sub-section sub-request-invalid" role="alert">
        <h2>暂时无法查看订单</h2>
        <p>{error ?? "请稍后重试。"}</p>
        <div className="sub-request-recovery">
          {queryRetryable && (
            <button className="sub-request-back-btn" type="button" onClick={queryAgain}>重新查询</button>
          )}
          <Link className="sub-request-back-btn" to="/subscribe">返回选择方案</Link>
        </div>
      </section>
    );
  }

  const copy = statusCopy(snapshot);
  return (
    <section className="sub-section" aria-live="polite">
      <div className="sub-request">
        <div className="sub-request-recap" aria-label="订单与服务状态">
          <div className="sub-request-recap-grid">
            <div><span>订单编号</span><b>{snapshot.orderRef}</b></div>
            <div><span>支付状态</span><b>{paymentLabel(snapshot.status)}</b></div>
            <div><span>服务状态</span><b>{serviceLabel(snapshot)}</b></div>
          </div>
          <div className="sub-request-recap-price">
            <span>应付金额</span>
            <b>{formatFen(snapshot.amountFen)}</b>
          </div>
        </div>

        <div className="sub-request-submit">
          <strong>{copy.title}</strong>
          <p>{copy.detail}</p>
          {snapshot.status === "closed" && (
            <button type="button" onClick={() => void retryPayment()} disabled={retrying} aria-busy={retrying}>
              {retrying ? "正在重新发起…" : "重新支付"}
            </button>
          )}
          {queryRetryable && (
            <button type="button" onClick={queryAgain}>重新查询</button>
          )}
          {error && <p className="sub-field-error" role="alert">{error}</p>}
        </div>

        {snapshot.service?.status === "open" && snapshot.service.items !== undefined && (
          <section className="sub-delivery" aria-labelledby="sub-delivery-title">
            <div className="sub-delivery-title">
              <div><small>DELIVERY</small><h2 id="sub-delivery-title">订阅信息</h2></div>
              <p>请妥善保管订阅链接，不要转发给他人。</p>
            </div>
            <div className="sub-delivery-list">
              {snapshot.service.items.map((item) => <DeliveryItemCard item={item} key={item.position} />)}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

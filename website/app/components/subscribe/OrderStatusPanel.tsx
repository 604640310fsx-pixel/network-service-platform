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
  refreshOrderQr,
  retryPaymentOrder,
  shouldClearAttemptAfterError,
  type OrderCredentials,
  type PaymentOrderResult,
  type PaymentOrderSnapshot,
  type ServiceDeliveryItem,
} from "../../lib/payment-api";
import { AlipayQrPay, type AlipayQrPhase } from "./AlipayQrPay";

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

function qrErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法刷新二维码，请稍后重试。";
  switch (error.code) {
    case "qr_unavailable":
      return "订单已失效，请点击“重新支付”获取新的二维码。";
    case "not_found":
      return "未找到该订单，或当前浏览器没有有效的查询凭证。";
    case "unauthorized":
      return "请登录下单时使用的账户后查看。";
    case "payment_unavailable":
      return "支付服务暂未开放，请稍后再试。";
    case "network_error":
      return "网络连接失败，请稍后重试。";
    default:
      return "暂时无法刷新二维码，请稍后重试。";
  }
}

function canManuallyRetryQuery(error: unknown): boolean {
  if (!(error instanceof PaymentApiError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404) return false;
  return error.code === "network_error" || error.code === "invalid_response" || error.status >= 500;
}

function initialQrCode(initialResult?: PaymentOrderResult): string | null {
  return initialResult !== undefined && initialResult.status === "pending" ? initialResult.qrCode : null;
}

export function OrderStatusPanel({
  orderRef,
  initialResult,
}: {
  orderRef: string;
  initialResult?: PaymentOrderResult;
}) {
  const navigate = useNavigate();
  const { status: authStatus } = useAuth();
  const [snapshot, setSnapshot] = useState<PaymentOrderSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queryRetryable, setQueryRetryable] = useState(false);
  const [queryGeneration, setQueryGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // 二维码内容只留在内存 state（来自 navigation state 的首个结果，或一次性取码恢复）；
  // 绝不写入 URL / localStorage / 日志。
  const [qrCode, setQrCode] = useState<string | null>(() => initialQrCode(initialResult));
  const [reservedUntil, setReservedUntil] = useState<string | null>(
    () => initialResult?.reservedUntil ?? null,
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const recoverAttempted = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

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
        // 有效期以服务端为准；本地已有（来自首个结果或取码）则保留，避免抖动。
        if (next.reservedUntil !== null) {
          setReservedUntil((prev) => prev ?? next.reservedUntil);
        }
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

  async function doRefreshQr(silent: boolean) {
    if (refreshingQr) return;
    setRefreshingQr(true);
    if (!silent) setActionError(null);
    try {
      const result = await refreshOrderQr(orderRef, accessTokenRef.current);
      if (result.status === "pending") {
        setQrCode(result.qrCode);
        setReservedUntil(result.reservedUntil);
        setNowMs(Date.now());
        setActionError(null);
      } else {
        // 订单已不在可支付状态：重新查询，让快照驱动 UI 切到 closed / paid。
        setQueryGeneration((generation) => generation + 1);
      }
    } catch (refreshError) {
      setActionError(qrErrorMessage(refreshError));
    } finally {
      setRefreshingQr(false);
    }
  }

  // 页面刷新且无二维码（navigation state 丢失）时，对 pending 订单只调用一次取码接口恢复。
  useEffect(() => {
    if (snapshot?.status !== "pending") return;
    if (qrCode !== null || recoverAttempted.current) return;
    recoverAttempted.current = true;
    void doRefreshQr(true);
    // doRefreshQr 读取的是 ref/最新 setter，无需进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, qrCode]);

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
    setActionError(null);
    setError(null);
    setQueryRetryable(false);
    let credentials: OrderCredentials | null = null;
    try {
      credentials = getOrCreateRetryAttempt(orderRef);
      const result = await retryPaymentOrder(orderRef, accessTokenRef.current, credentials);
      bindOrderAccess(result.orderRef, credentials);
      // 不再跳转支付宝网页收银台；站内跳转到新订单页并携带其首个支付结果（含二维码）。
      navigate(`/subscribe/request?orderRef=${encodeURIComponent(result.orderRef)}`, {
        replace: true,
        state: { paymentResult: result },
      });
    } catch (retryError) {
      if (credentials !== null && shouldClearAttemptAfterError(retryError)) {
        try {
          clearRetryAttempt(credentials);
        } catch {
          // 保留原始请求错误；本地存储不可用时无法额外清理。
        }
      }
      setActionError(orderErrorMessage(retryError));
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

  const reservedMs = reservedUntil === null ? null : Date.parse(reservedUntil);
  const secondsLeft =
    reservedMs === null || !Number.isFinite(reservedMs)
      ? null
      : Math.max(0, Math.round((reservedMs - nowMs) / 1000));

  let phase: AlipayQrPhase;
  if (snapshot.status === "paid") {
    phase = "paid";
  } else if (snapshot.status === "closed") {
    phase = "closed";
  } else if (secondsLeft !== null && secondsLeft <= 0) {
    // 倒计时归零但仍 pending：正在确认支付结果，继续轮询，不允许重新支付。
    phase = "confirming";
  } else {
    phase = "waiting";
  }

  const deliveryItems =
    snapshot.service?.status === "open" ? snapshot.service.items : undefined;

  return (
    <div className="pay-stack">
      <AlipayQrPay
        phase={phase}
        orderRef={snapshot.orderRef}
        amountFen={snapshot.amountFen}
        qrCode={phase === "waiting" ? qrCode : null}
        secondsLeft={phase === "waiting" ? secondsLeft : null}
        onRefreshQr={() => void doRefreshQr(false)}
        refreshing={refreshingQr}
        onRetry={() => void retryPayment()}
        retrying={retrying}
        actionError={actionError}
      />

      {snapshot.status !== "closed" && error !== null && queryRetryable && (
        <div className="pay-requery" role="alert">
          <p>{error}</p>
          <button type="button" onClick={queryAgain}>重新查询</button>
        </div>
      )}

      {deliveryItems !== undefined && (
        <section className="sub-section sub-delivery-panel" aria-labelledby="sub-delivery-title">
          <div className="sub-delivery-title">
            <div><small>DELIVERY</small><h2 id="sub-delivery-title">订阅信息</h2></div>
            <p>请妥善保管订阅链接，不要转发给他人。</p>
          </div>
          <div className="sub-delivery-list">
            {deliveryItems.map((item) => <DeliveryItemCard item={item} key={item.position} />)}
          </div>
        </section>
      )}
    </div>
  );
}

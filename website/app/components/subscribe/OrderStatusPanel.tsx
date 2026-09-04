import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import {
  PaymentApiError,
  bindOrderAccess,
  clearRetryAttempt,
  getOrCreateRetryAttempt,
  getPaymentOrder,
  readOrderAccessToken,
  refreshOrderPayPage,
  retryPaymentOrder,
  shouldClearAttemptAfterError,
  type OrderCredentials,
  type PaymentOrderResult,
  type PaymentOrderSnapshot,
} from "../../lib/payment-api";
import { SubscriptionImportModule } from "../subscription-import";
import { AlipayQrPay, type AlipayQrPhase } from "./AlipayQrPay";

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

function payPageErrorMessage(error: unknown): string {
  if (!(error instanceof PaymentApiError)) return "暂时无法刷新支付页面，请稍后重试。";
  switch (error.code) {
    case "pay_page_unavailable":
    case "qr_unavailable":
      return "订单已失效，请点击“重新支付”获取新的支付页面。";
    case "not_found":
      return "未找到该订单，或当前浏览器没有有效的查询凭证。";
    case "unauthorized":
      return "请登录下单时使用的账户后查看。";
    case "payment_unavailable":
      return "支付服务暂未开放，请稍后再试。";
    case "network_error":
      return "网络连接失败，请稍后重试。";
    default:
      return "暂时无法刷新支付页面，请稍后重试。";
  }
}

function canManuallyRetryQuery(error: unknown): boolean {
  if (!(error instanceof PaymentApiError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404) return false;
  return error.code === "network_error" || error.code === "invalid_response" || error.status >= 500;
}

function initialPayUrl(initialResult?: PaymentOrderResult): string | null {
  return initialResult !== undefined && initialResult.status === "pending" ? initialResult.payUrl : null;
}

const ALIPAY_RETURN_MESSAGE = "nsp.alipay.return";

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
  // 支付页地址只留在内存 state（来自 navigation state 的首个结果，或一次性恢复）；
  // 绝不写入 URL / localStorage / 日志。
  const [payUrl, setPayUrl] = useState<string | null>(() => initialPayUrl(initialResult));
  const [reservedUntil, setReservedUntil] = useState<string | null>(
    () => initialResult?.reservedUntil ?? null,
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [refreshingPayPage, setRefreshingPayPage] = useState(false);
  const [returningFromAlipay, setReturningFromAlipay] = useState(false);
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
        // 有效期以服务端为准；本地已有（来自首个结果或支付页恢复）则保留，避免抖动。
        if (next.reservedUntil !== null) {
          setReservedUntil((prev) => prev ?? next.reservedUntil);
        }
        if (next.status !== "pending") setPayUrl(null);
        setReturningFromAlipay(false);
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
        setReturningFromAlipay(false);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      controller.abort();
    };
  }, [authStatus, orderRef, queryGeneration]);

  useEffect(() => {
    function handleAlipayReturn(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (typeof event.data !== "object" || event.data === null) return;
      const message = event.data as { type?: unknown; orderRef?: unknown };
      if (message.type !== ALIPAY_RETURN_MESSAGE || message.orderRef !== orderRef) return;
      // 同源回跳只触发服务端权威查单；绝不据此直接写入 paid。
      setReturningFromAlipay(true);
      setPayUrl(null);
      setQueryGeneration((generation) => generation + 1);
    }
    window.addEventListener("message", handleAlipayReturn);
    return () => window.removeEventListener("message", handleAlipayReturn);
  }, [orderRef]);

  async function doRefreshPayPage(silent: boolean) {
    if (refreshingPayPage) return;
    setRefreshingPayPage(true);
    if (!silent) setActionError(null);
    try {
      const result = await refreshOrderPayPage(orderRef, accessTokenRef.current);
      if (result.status === "pending") {
        setPayUrl(result.payUrl);
        setReservedUntil(result.reservedUntil);
        setNowMs(Date.now());
        setActionError(null);
      } else {
        // 订单已不在可支付状态：重新查询，让快照驱动 UI 切到 closed / paid。
        setQueryGeneration((generation) => generation + 1);
      }
    } catch (refreshError) {
      setActionError(payPageErrorMessage(refreshError));
    } finally {
      setRefreshingPayPage(false);
    }
  }

  // 页面刷新且无 payUrl（navigation state 丢失）时，对 pending 订单只调用一次接口恢复。
  useEffect(() => {
    if (snapshot?.status !== "pending") return;
    if (payUrl !== null || recoverAttempted.current) return;
    recoverAttempted.current = true;
    void doRefreshPayPage(true);
    // doRefreshPayPage 读取的是 ref/最新 setter，无需进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, payUrl]);

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
      // 站内跳转到新订单页并以内存 navigation state 携带首个支付结果（含 payUrl）。
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
  } else if (returningFromAlipay) {
    phase = "confirming";
  } else if (secondsLeft !== null && secondsLeft <= 0) {
    // 倒计时归零但仍 pending：正在确认支付结果，继续轮询，不允许重新支付。
    phase = "confirming";
  } else {
    phase = "waiting";
  }

  const deliveryItems =
    snapshot.service?.status === "open" ? snapshot.service.items : undefined;

  return (
    <>
      <div className="pay-stack">
        <AlipayQrPay
          phase={phase}
          orderRef={snapshot.orderRef}
          amountFen={snapshot.amountFen}
          payUrl={phase === "waiting" ? payUrl : null}
          secondsLeft={phase === "waiting" ? secondsLeft : null}
          onRefreshPayPage={() => void doRefreshPayPage(false)}
          refreshing={refreshingPayPage}
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
      </div>

      {deliveryItems !== undefined && (
        <SubscriptionImportModule deliveryItems={deliveryItems} />
      )}
    </>
  );
}

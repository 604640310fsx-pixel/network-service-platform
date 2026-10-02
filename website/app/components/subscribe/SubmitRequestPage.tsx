import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { CustomerCenterShell } from "../customer/CustomerCenterShell";
import { RequirementForm } from "./RequirementForm";
import { OrderStatusPanel } from "./OrderStatusPanel";
import {
  PAYMENT_MAX_SINGLE_FEN_FRONTEND,
  readLastOrderRef,
  type PaymentOrderResult,
} from "../../lib/payment-api";

const ALIPAY_RETURN_MESSAGE = "nsp.alipay.return";

/* 从 navigation state 读取"首个支付结果"（RequirementForm / 重新支付跳转时携带）。
   仅当它对应当前 orderRef 才采纳，供支付页首屏直接加载支付宝电脑网站收银台。
   payUrl 只经内存中的 navigation state 传递，不进 URL / localStorage / 日志。 */
function readInitialResult(state: unknown, orderRef: string): PaymentOrderResult | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const candidate = (state as { paymentResult?: unknown }).paymentResult;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const result = candidate as PaymentOrderResult;
  return result.orderRef === orderRef ? result : undefined;
}
import { parseSelectionParams, resolveSelection, selectionToQuery } from "../../lib/resolveSelection";
import { usePlanAvailability } from "../../lib/planAvailability";
import "./subscribe.css";

/* 独立"提交方案需求"页。状态完全来自 URL 的公开 catalog ID，经 resolveSelection 依赖链
   校验；orderRef 分支查询真实订单状态，未完成选择时不渲染空表单。
   本页不含步骤条、右侧摘要栏与移动底栏，不模拟支付或开通结果。
   独立拉取一次 availability——不依赖 SubscribePage 是否已加载过，直达本页（如分享链接）
   同样能拿到服务器权威的可售状态与实时价格。 */
export function SubmitRequestPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const t = useT();
  const copy = t.subscribe.request;
  const availability = usePlanAvailability();
  const explicitOrderRef = searchParams.get("orderRef")?.trim() ?? "";
  const alipayOrderRef = searchParams.get("out_trade_no")?.trim() ?? "";
  const fromAlipay = searchParams.get("from") === "alipay";
  // orderRef 是本站显式定位参数；支付宝同步回跳只用 out_trade_no 定位查询，不据此判断支付结果。
  const orderRef = explicitOrderRef || alipayOrderRef;
  const selection = parseSelectionParams(searchParams);
  const { summary } = resolveSelection(selection, availability.index ?? undefined);
  const restoredOrderRef = orderRef === "" && searchParams.size === 0 && !summary.complete
    ? readLastOrderRef() ?? ""
    : "";
  const visibleOrderRef = orderRef || restoredOrderRef;
  const amountFen = summary.total === null ? null : Math.round(summary.total * 100);
  const overPaymentLimit = amountFen !== null && amountFen > PAYMENT_MAX_SINGLE_FEN_FRONTEND;
  const unavailable = summary.availability === "sold_out" || summary.availability === "unavailable";

  useEffect(() => {
    if (!fromAlipay || orderRef === "" || window.parent === window) return;
    // iframe 内的同源回跳只通知父页面立即发起权威查单；消息本身绝不代表已支付。
    window.parent.postMessage(
      { type: ALIPAY_RETURN_MESSAGE, orderRef },
      window.location.origin,
    );
  }, [fromAlipay, orderRef]);

  if (visibleOrderRef !== "") {
    const initialResult = readInitialResult(location.state, visibleOrderRef);
    return (
      <CustomerCenterShell title={copy.statusTitle} description={copy.statusDescription}>
        <main className="sub-page">
          <div className="sub-request-page">
            <OrderStatusPanel key={visibleOrderRef} orderRef={visibleOrderRef} initialResult={initialResult} />
          </div>
        </main>
      </CustomerCenterShell>
    );
  }

  return (
    <CustomerCenterShell title={copy.title} description={copy.description}>
      <main className="sub-page">
        <div className="sub-request-page">
          {overPaymentLimit ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{copy.overLimitTitle}</h2>
              <p>{copy.overLimitBody}</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>{copy.backToEdit}</Link>
            </section>
          ) : !summary.complete ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{copy.invalidTitle}</h2>
              <p>{copy.invalidBody}</p>
              <Link className="sub-request-back-btn" to="/subscribe">{copy.backToChoose}</Link>
            </section>
          ) : availability.loading ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{copy.checkingTitle}</h2>
              <p>{copy.checkingBody}</p>
            </section>
          ) : availability.error ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{copy.priceUnavailableTitle}</h2>
              <p>{copy.priceUnavailableBody}</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>{copy.backToEdit}</Link>
            </section>
          ) : unavailable ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{summary.availability === "sold_out" ? copy.soldOutTitle : copy.unavailableTitle}</h2>
              <p>{copy.chooseOther}</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>{copy.backToEdit}</Link>
            </section>
          ) : (
            <>
              <div className="sub-request-page-bar">
                <Link className="sub-request-back" to={`/subscribe?${selectionToQuery(selection)}`}>
                  <span aria-hidden="true">←</span> {copy.backToEdit}
                </Link>
              </div>
              <section className="sub-section">
                <RequirementForm summary={summary} selection={selection} />
              </section>
            </>
          )}
        </div>
      </main>
    </CustomerCenterShell>
  );
}

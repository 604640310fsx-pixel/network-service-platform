import { Link, useLocation, useSearchParams } from "react-router-dom";
import { CustomerCenterShell } from "../customer/CustomerCenterShell";
import { RequirementForm } from "./RequirementForm";
import { OrderStatusPanel } from "./OrderStatusPanel";
import {
  PAYMENT_MAX_SINGLE_FEN_FRONTEND,
  readLastOrderRef,
  type PaymentOrderResult,
} from "../../lib/payment-api";

/* 从 navigation state 读取"首个支付结果"（RequirementForm / 重新支付跳转时携带）。
   仅当它对应当前 orderRef 才采纳，供支付页首屏直接渲染二维码，避免额外一次取码。
   二维码内容只经内存中的 navigation state 传递，不进 URL / localStorage / 日志。 */
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
  const availability = usePlanAvailability();
  const explicitOrderRef = searchParams.get("orderRef")?.trim() ?? "";
  const alipayOrderRef = searchParams.get("out_trade_no")?.trim() ?? "";
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

  if (visibleOrderRef !== "") {
    const initialResult = readInitialResult(location.state, visibleOrderRef);
    return (
      <CustomerCenterShell title="服务状态" description="查看支付结果与服务开通进度">
        <main className="sub-page">
          <div className="sub-request-page">
            <OrderStatusPanel orderRef={visibleOrderRef} initialResult={initialResult} />
          </div>
        </main>
      </CustomerCenterShell>
    );
  }

  return (
    <CustomerCenterShell title="提交方案需求" description="核对已选方案并填写交付信息，提交后立即付款">
      <main className="sub-page">
        <div className="sub-request-page">
          {overPaymentLimit ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>暂不支持在线购买</h2>
              <p>该方案超过当前在线支付限额，请返回选择其他规格或周期。</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>返回修改方案</Link>
            </section>
          ) : !summary.complete ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>方案信息已失效</h2>
              <p>请返回网络方案页重新选择</p>
              <Link className="sub-request-back-btn" to="/subscribe">返回选择方案</Link>
            </section>
          ) : availability.loading ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>价格核对中</h2>
              <p>正在获取服务器实时价格与库存，请稍候。</p>
            </section>
          ) : availability.error ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>价格暂不可用</h2>
              <p>价格暂不可用，请稍后重试。</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>返回修改方案</Link>
            </section>
          ) : unavailable ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>{summary.availability === "sold_out" ? "该方案已售罄" : "该方案暂不可选"}</h2>
              <p>请返回选择其他规格或周期。</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>返回修改方案</Link>
            </section>
          ) : (
            <>
              <div className="sub-request-page-bar">
                <Link className="sub-request-back" to={`/subscribe?${selectionToQuery(selection)}`}>
                  <span aria-hidden="true">←</span> 返回修改方案
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

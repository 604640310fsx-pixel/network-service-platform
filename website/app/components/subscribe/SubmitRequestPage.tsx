import { Link, useSearchParams } from "react-router-dom";
import { CustomerCenterShell } from "../customer/CustomerCenterShell";
import { RequirementForm } from "./RequirementForm";
import { OrderStatusPanel } from "./OrderStatusPanel";
import { PAYMENT_MAX_SINGLE_FEN_FRONTEND } from "../../lib/payment-api";
import { parseSelectionParams, resolveSelection, selectionToQuery } from "../../lib/resolveSelection";
import "./subscribe.css";

/* 独立"提交方案需求"页。状态完全来自 URL 的公开 catalog ID，经 resolveSelection 依赖链
   校验；orderRef 分支查询真实订单状态，未完成选择时不渲染空表单。
   本页不含步骤条、右侧摘要栏与移动底栏，不模拟支付或开通结果。 */
export function SubmitRequestPage() {
  const [searchParams] = useSearchParams();
  const explicitOrderRef = searchParams.get("orderRef")?.trim() ?? "";
  const alipayOrderRef = searchParams.get("out_trade_no")?.trim() ?? "";
  // orderRef 是本站显式定位参数；支付宝同步回跳只用 out_trade_no 定位查询，不据此判断支付结果。
  const orderRef = explicitOrderRef || alipayOrderRef;
  const selection = parseSelectionParams(searchParams);
  const { summary } = resolveSelection(selection);
  const amountFen = summary.total === null ? null : Math.round(summary.total * 100);
  const overPaymentLimit = amountFen !== null && amountFen > PAYMENT_MAX_SINGLE_FEN_FRONTEND;

  if (orderRef !== "") {
    return (
      <CustomerCenterShell title="服务状态" description="查看支付结果与服务开通进度">
        <main className="sub-page">
          <div className="sub-request-page">
            <OrderStatusPanel orderRef={orderRef} />
          </div>
        </main>
      </CustomerCenterShell>
    );
  }

  return (
    <CustomerCenterShell title="提交方案需求" description="核对已选方案并填写交付信息，提交后立即付款">
      <main className="sub-page">
        <div className="sub-request-page">
          {summary.complete && !overPaymentLimit ? (
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
          ) : overPaymentLimit ? (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>暂不支持在线购买</h2>
              <p>该方案超过当前在线支付限额，请返回选择其他规格或周期。</p>
              <Link className="sub-request-back-btn" to={`/subscribe?${selectionToQuery(selection)}`}>返回修改方案</Link>
            </section>
          ) : (
            <section className="sub-section sub-request-invalid" role="status">
              <h2>方案信息已失效</h2>
              <p>请返回网络方案页重新选择</p>
              <Link className="sub-request-back-btn" to="/subscribe">返回选择方案</Link>
            </section>
          )}
        </div>
      </main>
    </CustomerCenterShell>
  );
}

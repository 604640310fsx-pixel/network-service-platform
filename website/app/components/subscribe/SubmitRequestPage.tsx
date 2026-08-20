import { Link, useSearchParams } from "react-router-dom";
import { CustomerCenterShell } from "../customer/CustomerCenterShell";
import { RequirementForm } from "./RequirementForm";
import { parseSelectionParams, resolveSelection, selectionToQuery } from "../../lib/resolveSelection";
import "./subscribe.css";

/* 独立"提交方案需求"页。状态完全来自 URL 的公开 catalog ID，经 resolveSelection 依赖链
   校验；只有 summary.complete 时才渲染需求表单，否则显示失效屏（不渲染空表单）。
   本页不含步骤条、右侧摘要栏与移动底栏；提交按钮仍禁用（提交功能待接入），不模拟成功。 */
export function SubmitRequestPage() {
  const [searchParams] = useSearchParams();
  const selection = parseSelectionParams(searchParams);
  const { summary } = resolveSelection(selection);

  return (
    <CustomerCenterShell title="提交方案需求" description="核对已选方案并填写交付信息，提交后立即付款">
      <main className="sub-page">
        <div className="sub-request-page">
          {summary.complete ? (
            <>
              <div className="sub-request-page-bar">
                <Link className="sub-request-back" to={`/subscribe?${selectionToQuery(selection)}`}>
                  <span aria-hidden="true">←</span> 返回修改方案
                </Link>
              </div>
              <section className="sub-section">
                <RequirementForm summary={summary} />
              </section>
            </>
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

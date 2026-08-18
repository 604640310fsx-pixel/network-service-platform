import type { SelectionSummary } from "./useSubscriptionSelection";

type OrderSummaryProps = {
  summary: SelectionSummary;
  drawer?: boolean;
};

function value(value: string) {
  return value || "—";
}

export function OrderSummary({ summary, drawer = false }: OrderSummaryProps) {
  const showListPrice = summary.total !== null && summary.listPrice !== null && summary.total < summary.listPrice;
  return (
    <div className={`sub-summary-card ${drawer ? "is-drawer" : ""}`}>
      <div className="sub-summary-head"><b>订单摘要</b><span>prototype 演示</span></div>
      <div className="sub-summary-rows">
        <div><span>网络类型</span><b>{value(summary.type)}</b></div>
        <div><span>国家/地区</span><b>{value(summary.region)}</b></div>
        <div><span>运营商</span><b>{value(summary.isp)}</b></div>
        <div><span>规格</span><b>{value(summary.spec)}</b></div>
        <div><span>有效期</span><b>{value(summary.duration)}</b></div>
        <hr />
        <div><span>月流量</span><b>{value(summary.traffic)}</b></div>
        <div><span>带宽</span><b>{summary.complete ? "最高 100M" : "—"}</b></div>
        <div><span>IP 类型</span><b>{summary.complete ? "静态住宅 IP" : "—"}</b></div>
        <div><span>UDP 支持</span><b className={summary.complete ? "is-accent" : ""}>{summary.complete ? "完整支持" : "—"}</b></div>
        <div><span>DNS</span><b>{summary.complete ? "一致" : "—"}</b></div>
      </div>
      <div className="sub-summary-total">
        <span>演示金额</span>
        <div>
          <s>{showListPrice ? `¥${summary.listPrice}` : ""}</s>
          <b>{summary.total === null ? "—" : `¥${summary.total}`}</b>
        </div>
      </div>
      <div className="sub-summary-pay">
        <button type="button" disabled>立即下单</button>
        <p>界面演示，套餐与价格待确认</p>
      </div>
    </div>
  );
}

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
      <div className="sub-summary-head">
        <span><small>SOLUTION SUMMARY</small><b>方案摘要</b></span>
        <i>CATALOG V1</i>
      </div>
      <div className="sub-summary-rows">
        <div><span>网络类型</span><b>{value(summary.type)}</b></div>
        <div><span>国家/地区</span><b>{value(summary.region)}</b></div>
        <div><span>运营商</span><b>{value(summary.isp)}</b></div>
        <div><span>规格</span><b>{value(summary.spec)}</b></div>
        <div><span>有效期</span><b>{value(summary.duration)}</b></div>
        <hr />
        <div><span>月流量</span><b>{value(summary.traffic)}</b></div>
        <div><span>带宽</span><b>{value(summary.bandwidth)}</b></div>
        <div><span>IP 类型</span><b>{value(summary.ipType)}</b></div>
        <div><span>UDP 支持</span><b>{value(summary.udp)}</b></div>
        <div><span>DNS</span><b>{value(summary.dns)}</b></div>
      </div>
      <div className="sub-summary-total">
        <span><small>CATALOG PRICE</small>目录价格</span>
        <div>
          <s>{showListPrice ? `¥${summary.listPrice}` : ""}</s>
          <b>{summary.total === null ? "—" : `¥${summary.total}`}</b>
        </div>
      </div>
      <div className="sub-summary-pay">
        <button type="button" disabled>方案提交待开放</button>
        <p>价格来自产品目录，本页不创建订单或支付</p>
      </div>
    </div>
  );
}

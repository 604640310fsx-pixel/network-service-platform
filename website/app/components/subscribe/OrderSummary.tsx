import { useCatalogText, useT } from "../../lib/i18n";
import type { SelectionSummary } from "./useSubscriptionSelection";

type OrderSummaryProps = {
  summary: SelectionSummary;
  canRequest: boolean;
  drawer?: boolean;
  onRequest?: () => void;
};


export function OrderSummary({ summary, canRequest, drawer = false, onRequest }: OrderSummaryProps) {
  const t = useT();
  const copy = t.subscribe.summary;
  const ct = useCatalogText();
  const value = (text: string) => (text ? ct(text) : "—");
  const authoritativeTotal = summary.availability === "available" ? summary.total : null;
  const showListPrice = authoritativeTotal !== null && summary.listPrice !== null && authoritativeTotal < summary.listPrice;
  const priceLabel = authoritativeTotal === null ? t.subscribe.pricePending : `¥${authoritativeTotal}`;
  return (
    <div className={`sub-summary-card ${drawer ? "is-drawer" : ""}`}>
      <div className="sub-summary-head">
        <span><small>SOLUTION SUMMARY</small><b>{copy.title}</b></span>
        <i>CATALOG V1</i>
      </div>
      <div className="sub-summary-rows">
        <div><span>{copy.type}</span><b>{value(summary.type)}</b></div>
        <div><span>{copy.region}</span><b>{value(summary.region)}</b></div>
        <div><span>{copy.isp}</span><b>{value(summary.isp)}</b></div>
        <div><span>{copy.spec}</span><b>{value(summary.spec)}</b></div>
        <div><span>{copy.duration}</span><b>{value(summary.duration)}</b></div>
        <hr />
        <div><span>{copy.traffic}</span><b>{value(summary.traffic)}</b></div>
        <div><span>{copy.bandwidth}</span><b>{value(summary.bandwidth)}</b></div>
        <div><span>{copy.ipType}</span><b>{value(summary.ipType)}</b></div>
        <div><span>{copy.udp}</span><b>{value(summary.udp)}</b></div>
        <div><span>{copy.dns}</span><b>{value(summary.dns)}</b></div>
      </div>
      <div className="sub-summary-total">
        <span><small>CATALOG PRICE</small>{copy.catalogPrice}</span>
        <div>
          <s>{showListPrice ? `¥${summary.listPrice}` : ""}</s>
          <b>{priceLabel}</b>
        </div>
      </div>
      <div className="sub-summary-pay">
        <button type="button" disabled={!canRequest} onClick={onRequest}>{copy.orderNow}</button>
        <p>{copy.payNote}</p>
      </div>
    </div>
  );
}

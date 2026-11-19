import { useCatalogText, useT } from "../../lib/i18n";
import type { SelectionSummary } from "./useSubscriptionSelection";
import type { MonthlyPresentation } from "./subscriptionPresentation";

type OrderSummaryProps = {
  summary: SelectionSummary;
  canRequest: boolean;
  drawer?: boolean;
  onRequest?: () => void;
  presentation?: { monthly: MonthlyPresentation; line: string | null; months: number | null };
};


export function OrderSummary({ summary, canRequest, drawer = false, onRequest, presentation }: OrderSummaryProps) {
  const t = useT();
  const copy = t.subscribe.summary;
  const ct = useCatalogText();
  const value = (text: string) => (text ? ct(text) : "—");
  const authoritativeTotal = summary.availability === "available" ? summary.total : null;
  const showListPrice = authoritativeTotal !== null && summary.listPrice !== null && authoritativeTotal < summary.listPrice;
  const priceLabel = authoritativeTotal === null ? t.subscribe.pricePending : `¥${authoritativeTotal}`;
  const ui = t.subscribe.configurator;
  const monthly = presentation?.monthly;
  const money = (fen: number) => `¥${Number.isInteger(fen / 100) ? fen / 100 : (fen / 100).toFixed(2)}`;
  const months = presentation?.months;
  const savings = months && monthly && authoritativeTotal !== null ? Math.max(0, monthly.monthlyFen / 100 * months - authoritativeTotal) : null;
  return (
    <div className={`sub-summary-card ${drawer ? "is-drawer" : ""}`}>
      <div className="sub-summary-head">
        <b>{copy.title}</b>
      </div>
      <div className="sub-summary-rows">
        <div><span>{copy.type}</span><b>{value(summary.type)}</b></div>
        <div><span>{copy.region}</span><b>{value(summary.region)}{!summary.ispImplied && summary.isp !== "—" ? ` · ${value(summary.isp)}` : ""}</b></div>
        <div><span>{copy.traffic}</span><b>{value(summary.traffic)}</b></div>
        {presentation?.line && <div><span>{t.residentialOptions.line}</span><b>{presentation.line}</b></div>}
        {summary.residentialOptions && <div><span>{t.residentialOptions.device}</span><b>{t.subscribe.residentialTrafficDevices(summary.residentialOptions.deviceAllowance)}</b></div>}
        <div><span>{copy.duration}</span><b>{value(summary.duration)}</b></div>
      </div>
      {monthly && <div className="sub-summary-breakdown">
        {monthly.baseMonthlyFen !== null && <div><span>{ui.baseMonthly}</span><b>{money(monthly.baseMonthlyFen)}</b></div>}
        {presentation?.line && monthly.addonMonthlyFen !== null && <div><span>{ui.lineAddon}</span><b>+{money(monthly.addonMonthlyFen)}</b></div>}
        <div><strong>{ui.monthlyTotal}</strong><b>{money(monthly.monthlyFen)}</b></div>
        {summary.residentialOptions?.basePeriodFen !== undefined && <>
          <div><span>{t.residentialOptions.basePeriod}</span><b>{money(summary.residentialOptions.basePeriodFen)}</b></div>
          <div><span>{t.residentialOptions.addonPeriod}</span><b>+{money(summary.residentialOptions.addonPeriodFen!)}</b></div>
        </>}
      </div>}
      <div className="sub-summary-total">
        <span>{ui.payable}<small>{ui.catalogTerm}{months ? ` · ${value(summary.duration)}` : ""}</small></span>
        <div>
          <s>{showListPrice ? `¥${summary.listPrice}` : ""}</s>
          <b>{priceLabel}</b>
        </div>
      </div>
      {authoritativeTotal !== null && months && <p className="sub-summary-term">{ui.average((authoritativeTotal / months).toFixed(2))}{savings !== null && savings > 0 ? ` · ${ui.saves(savings.toFixed(2))}` : ""}</p>}
      <div className="sub-summary-pay">
        <button type="button" disabled={!canRequest} onClick={onRequest}>{copy.orderNow}</button>
        <p>{copy.payNote}</p>
      </div>
    </div>
  );
}

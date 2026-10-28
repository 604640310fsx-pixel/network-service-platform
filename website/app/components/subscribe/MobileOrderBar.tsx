import { useCatalogText, useT } from "../../lib/i18n";
import type { SelectionSummary } from "./useSubscriptionSelection";

type MobileOrderBarProps = {
  summary: SelectionSummary;
  canRequest: boolean;
  open: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
  onRequest?: () => void;
};

export function MobileOrderBar({ summary, canRequest, open, onOpen, onRequest }: MobileOrderBarProps) {
  const t = useT();
  const ct = useCatalogText();
  const details = [summary.type, summary.region, summary.spec, summary.duration]
    .filter((item) => item !== "—" && item !== "不适用")
    .map(ct)
    .join(" · ") || t.subscribe.summary.notSelected;
  const priceLabel = summary.availability === "available" && summary.total !== null
    ? `¥${summary.total}`
    : t.subscribe.pricePending;
  return (
    <div className="sub-mobile-order-bar">
      <button type="button" className="sub-mobile-order-info" aria-expanded={open} onClick={(event) => onOpen(event.currentTarget)}>
        <span className="sub-mobile-order-price">{priceLabel}</span>
        <span className="sub-mobile-order-detail">{details}<i aria-hidden="true">⌃</i></span>
      </button>
      <button type="button" className="sub-order-button" disabled={!canRequest} onClick={onRequest}>{t.subscribe.summary.orderNow}</button>
    </div>
  );
}

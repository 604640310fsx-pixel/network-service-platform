import type { SelectionSummary } from "./useSubscriptionSelection";

type MobileOrderBarProps = {
  summary: SelectionSummary;
  canRequest: boolean;
  open: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
  onRequest?: () => void;
};

export function MobileOrderBar({ summary, canRequest, open, onOpen, onRequest }: MobileOrderBarProps) {
  const details = [summary.type, summary.region, summary.spec, summary.duration].filter((item) => item !== "—" && item !== "不适用").join(" · ") || "尚未完成选择";
  const priceLabel = summary.availability === "available" && summary.total !== null
    ? `¥${summary.total}`
    : "价格待确认";
  return (
    <div className="sub-mobile-order-bar">
      <button type="button" className="sub-mobile-order-info" aria-expanded={open} onClick={(event) => onOpen(event.currentTarget)}>
        <span className="sub-mobile-order-price">{priceLabel}</span>
        <span className="sub-mobile-order-detail">{details}<i aria-hidden="true">⌃</i></span>
      </button>
      <button type="button" className="sub-order-button" disabled={!canRequest} onClick={onRequest}>立即下单</button>
    </div>
  );
}

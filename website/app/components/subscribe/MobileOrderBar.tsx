import type { SelectionSummary } from "./useSubscriptionSelection";

type MobileOrderBarProps = {
  summary: SelectionSummary;
  open: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
};

export function MobileOrderBar({ summary, open, onOpen }: MobileOrderBarProps) {
  const details = [summary.type, summary.region, summary.spec, summary.duration].filter((item) => item !== "—").join(" · ") || "尚未完成选择";
  return (
    <div className="sub-mobile-order-bar">
      <button type="button" className="sub-mobile-order-info" aria-expanded={open} onClick={(event) => onOpen(event.currentTarget)}>
        <span className="sub-mobile-order-price">{summary.total === null ? "—" : `¥${summary.total}`}</span>
        <span className="sub-mobile-order-detail">{details}<i aria-hidden="true">⌃</i></span>
      </button>
      <button type="button" className="sub-order-button" disabled>提交待开放</button>
    </div>
  );
}

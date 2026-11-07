import { useEffect, useRef } from "react";
import { useCatalogText, useT } from "../../lib/i18n";
import type { SelectionSummary } from "./useSubscriptionSelection";

type MobileOrderBarProps = {
  summary: SelectionSummary;
  canRequest: boolean;
  open: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
  onRequest?: () => void;
  months?: number | null;
};

export function MobileOrderBar({ summary, canRequest, open, onOpen, onRequest, months }: MobileOrderBarProps) {
  const t = useT();
  const ct = useCatalogText();
  const barRef = useRef<HTMLDivElement>(null);
  // Same pattern as StepProgress: publish the bar's rendered height (including its safe-area padding) on this page only,
  // for the drawer and page-end reserves. The bar never reads it, so there is no sizing feedback loop. A hidden bar has no
  // height and removes the value, so the CSS fallback applies.
  useEffect(() => {
    const bar = barRef.current;
    const page = bar?.closest<HTMLElement>(".sub-configurator-v11");
    if (!bar || !page) return;
    const syncHeight = () => {
      const height = bar.getBoundingClientRect().height;
      if (height > 0) page.style.setProperty("--sub-order-bar-height", `${height}px`);
      else page.style.removeProperty("--sub-order-bar-height");
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncHeight);
    observer?.observe(bar);
    return () => {
      window.removeEventListener("resize", syncHeight);
      observer?.disconnect();
      page.style.removeProperty("--sub-order-bar-height");
    };
  }, []);
  const details = [summary.type, summary.region, summary.spec, summary.duration]
    .filter((item) => item !== "—" && item !== "不适用")
    .map(ct)
    .join(" · ") || t.subscribe.summary.notSelected;
  const priceLabel = summary.availability === "available" && summary.total !== null
    ? `¥${summary.total}`
    : t.subscribe.pricePending;
  return (
    <div ref={barRef} className="sub-mobile-order-bar">
      <button type="button" className="sub-mobile-order-info" aria-expanded={open} onClick={(event) => onOpen(event.currentTarget)}>
        <span className="sub-mobile-order-label">{t.subscribe.configurator.payable} · {ct(summary.duration)}</span>
        <span className="sub-mobile-order-price">{priceLabel}</span>
        <span className="sub-mobile-order-detail">{months && summary.availability === "available" && summary.total !== null ? t.subscribe.configurator.average((summary.total / months).toFixed(2)) : details}<i aria-hidden="true">⌃</i></span>
      </button>
      <button type="button" className="sub-order-button" disabled={!canRequest} onClick={onRequest}>{t.subscribe.summary.orderNow}</button>
    </div>
  );
}

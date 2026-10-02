import { QRCodeSVG } from "qrcode.react";
import { useT } from "../../lib/i18n";

/* 支付宝收银台不嵌入本站 iframe（可能被 X-Frame-Options 拒绝）。
   - 有当面付二维码内容（qrCode，qr.alipay.com 短地址）时：本地生成稀疏二维码供手机扫码，
     电脑网站收银台作为新窗口备用。
   - 没有 qrCode 时：按支付宝电脑网站支付「在商家页面扫码支付」，用完整收银台地址 payUrl
     本地生成二维码；内容较长、二维码较密，因此用最低纠错等级并放大显示。
   两种情况都保留新窗口打开收银台作为备用。
   本页继续自动查询支付结果；不生成另一套收款内容，也不持久化地址。 */
export type AlipayQrPhase = "waiting" | "confirming" | "paid" | "closed";

type AlipayQrPayProps = {
  readonly phase: AlipayQrPhase;
  readonly serviceOpen: boolean;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly payUrl: string | null;
  readonly qrCode: string | null;
  readonly secondsLeft: number | null;
  readonly onRefreshPayPage: () => void;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly actionError: string | null;
};

function formatFen(amountFen: number): string {
  const amount = amountFen / 100;
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function AlipayQrPay({
  phase,
  serviceOpen,
  orderRef,
  amountFen,
  payUrl,
  qrCode,
  secondsLeft,
  onRefreshPayPage,
  refreshing,
  onRetry,
  retrying,
  actionError,
}: AlipayQrPayProps) {
  const copy = useT().subscribe.pay;
  const amountLabel = phase === "paid" ? copy.paidAmount : copy.amountDue;
  return (
    <section className="pay-card" data-state={phase} aria-live="polite">
      <div className="pay-head">
        <span className="pay-kicker">ALIPAY · {copy.kickerMethod}</span>
        <span className="pay-status"><i aria-hidden="true" />{copy.status[phase]}</span>
      </div>

      <div className="pay-context">
        <span className="pay-order">{copy.orderNo} {orderRef}</span>
      </div>

      <div className="pay-amount">
        <span>{amountLabel}</span>
        <b>{formatFen(amountFen)}</b>
      </div>

      {phase === "waiting" && (
        <div className="pay-scan">
          {payUrl === null ? (
            <div className="pay-open-loading" role="status">{copy.loadingCashier}</div>
          ) : (
            <div className="pay-open">
              {qrCode !== null ? (
                <div className="pay-qr" role="img" aria-label={copy.qrLabel}>
                  <QRCodeSVG value={qrCode} size={240} level="M" marginSize={2} />
                </div>
              ) : (
                <div className="pay-qr is-dense" role="img" aria-label={copy.qrLabel}>
                  <QRCodeSVG value={payUrl} size={320} level="L" marginSize={4} />
                </div>
              )}
              <p className="pay-open-lead">{copy.scanLead}</p>
              <a className="pay-ghost pay-open-button" href={payUrl} target="_blank" rel="noopener noreferrer">
                {copy.openCashier}
              </a>
              <p className="pay-open-note">{copy.autoUpdate}</p>
            </div>
          )}
          <p className="pay-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20h.01M20 20v-3M17 20h.01"/></svg>
            {copy.hint}
          </p>
          <div className="pay-countdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            {secondsLeft === null ? copy.expiryLoading : <>{copy.remaining} <b>{formatCountdown(secondsLeft)}</b></>}
          </div>
          <button type="button" className="pay-refresh" onClick={onRefreshPayPage} disabled={refreshing} aria-busy={refreshing}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5"/><path d="M20 4v5h-5"/></svg>
            {refreshing ? copy.refreshing : copy.refresh}
          </button>
        </div>
      )}

      {phase === "confirming" && (
        <div className="pay-confirming" role="status">
          <span className="pay-spinner" aria-hidden="true" />
          <h2>{copy.confirmingTitle}</h2>
          <p>{copy.confirmingBody}</p>
        </div>
      )}

      {phase === "paid" && (
        <div className="pay-success">
          <div className="pay-success-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg></div>
          <h2>{copy.paidTitle}</h2>
          <p>
            {serviceOpen
              ? copy.paidOpen
              : copy.paidPending}
          </p>
        </div>
      )}

      {phase === "closed" && (
        <div className="pay-closed">
          <h2>{copy.closedTitle}</h2>
          <p>{copy.closedBody}</p>
          <button type="button" className="pay-primary" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
            {retrying ? copy.retrying : copy.retry}
          </button>
        </div>
      )}

      {actionError !== null && <p className="pay-error" role="alert">{actionError}</p>}
    </section>
  );
}

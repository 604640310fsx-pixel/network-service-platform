import { QRCodeSVG } from "qrcode.react";

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

const STATUS_LABEL: Record<AlipayQrPhase, string> = {
  waiting: "等待支付",
  confirming: "正在确认",
  paid: "已支付",
  closed: "支付页已失效",
};

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
  const amountLabel = phase === "paid" ? "已支付金额" : "应付金额";
  return (
    <section className="pay-card" data-state={phase} aria-live="polite">
      <div className="pay-head">
        <span className="pay-kicker">ALIPAY · 电脑网站支付</span>
        <span className="pay-status"><i aria-hidden="true" />{STATUS_LABEL[phase]}</span>
      </div>

      <div className="pay-context">
        <span className="pay-order">订单号 {orderRef}</span>
      </div>

      <div className="pay-amount">
        <span>{amountLabel}</span>
        <b>{formatFen(amountFen)}</b>
      </div>

      {phase === "waiting" && (
        <div className="pay-scan">
          {payUrl === null ? (
            <div className="pay-open-loading" role="status">正在获取支付宝收银台…</div>
          ) : (
            <div className="pay-open">
              {qrCode !== null ? (
                <div className="pay-qr" role="img" aria-label="支付宝付款二维码">
                  <QRCodeSVG value={qrCode} size={240} level="M" marginSize={2} />
                </div>
              ) : (
                <div className="pay-qr is-dense" role="img" aria-label="支付宝付款二维码">
                  <QRCodeSVG value={payUrl} size={320} level="L" marginSize={4} />
                </div>
              )}
              <p className="pay-open-lead">请使用手机支付宝扫码付款</p>
              <a className="pay-ghost pay-open-button" href={payUrl} target="_blank" rel="noopener noreferrer">
                或在新窗口打开支付宝收银台
              </a>
              <p className="pay-open-note">付款完成后无需操作，本页会自动更新结果。</p>
            </div>
          )}
          <p className="pay-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20h.01M20 20v-3M17 20h.01"/></svg>
            请按支付宝收银台提示完成付款，本页会自动查询支付结果。
          </p>
          <div className="pay-countdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            {secondsLeft === null ? "有效期读取中" : <>支付页剩余 <b>{formatCountdown(secondsLeft)}</b></>}
          </div>
          <button type="button" className="pay-refresh" onClick={onRefreshPayPage} disabled={refreshing} aria-busy={refreshing}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5"/><path d="M20 4v5h-5"/></svg>
            {refreshing ? "刷新中…" : "刷新收银台"}
          </button>
        </div>
      )}

      {phase === "confirming" && (
        <div className="pay-confirming" role="status">
          <span className="pay-spinner" aria-hidden="true" />
          <h2>正在确认支付结果</h2>
          <p>只以支付宝通知或主动查单结果为准，请勿重复支付。</p>
        </div>
      )}

      {phase === "paid" && (
        <div className="pay-success">
          <div className="pay-success-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg></div>
          <h2>支付成功</h2>
          <p>
            {serviceOpen
              ? "服务已开通，可在下方查看订阅信息。"
              : "服务已进入待开通状态，请在用户中心查看进度。"}
          </p>
        </div>
      )}

      {phase === "closed" && (
        <div className="pay-closed">
          <h2>支付页已失效</h2>
          <p>本次支付未完成，未生成服务。你可以重新发起付款。</p>
          <button type="button" className="pay-primary" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
            {retrying ? "正在重新发起…" : "重新支付"}
          </button>
        </div>
      )}

      {actionError !== null && <p className="pay-error" role="alert">{actionError}</p>}
    </section>
  );
}

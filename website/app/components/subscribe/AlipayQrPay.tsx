import { Component, type ErrorInfo, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";

/* 站内支付宝扫码支付卡片——已验收原型的忠实迁移（去掉状态预览控制器与"示例·不可支付"）。
   纯展示：状态、金额、二维码内容、倒计时与回调全部由 OrderStatusPanel 决定并下传。
   qrCode 只作为二维码内容渲染，不写入 URL / localStorage / 日志。 */
export type AlipayQrPhase = "waiting" | "confirming" | "paid" | "closed";

type AlipayQrPayProps = {
  readonly phase: AlipayQrPhase;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly qrCode: string | null;
  readonly secondsLeft: number | null;
  readonly onRefreshQr: () => void;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly actionError: string | null;
};

class QrRenderBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 二维码内容属于支付敏感数据，不写入日志或组件栈。
  }
  render() {
    if (this.state.failed) {
      return <p className="pay-qr-fallback" role="alert">二维码生成失败，请点击“刷新二维码”重试。</p>;
    }
    return this.props.children;
  }
}

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
  closed: "二维码已失效",
};

export function AlipayQrPay({
  phase,
  orderRef,
  amountFen,
  qrCode,
  secondsLeft,
  onRefreshQr,
  refreshing,
  onRetry,
  retrying,
  actionError,
}: AlipayQrPayProps) {
  const amountLabel = phase === "paid" ? "已支付金额" : "应付金额";
  return (
    <section className="pay-card" data-state={phase} aria-live="polite">
      <div className="pay-head">
        <span className="pay-kicker">ALIPAY · 扫码支付</span>
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
          <div className="pay-qr-frame">
            <span className="pay-corner tl" aria-hidden="true" /><span className="pay-corner tr" aria-hidden="true" />
            <span className="pay-corner bl" aria-hidden="true" /><span className="pay-corner br" aria-hidden="true" />
            {qrCode === null ? (
              <div className="pay-qr-loading" role="status">正在获取支付二维码…</div>
            ) : (
              <QrRenderBoundary>
                <QRCodeSVG value={qrCode} size={220} level="M" marginSize={2} aria-label="支付宝支付二维码" />
              </QrRenderBoundary>
            )}
          </div>
          <p className="pay-hint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20h.01M20 20v-3M17 20h.01"/></svg>
            无需在网页中登录支付宝，请使用支付宝 App 扫码完成付款。
          </p>
          <div className="pay-countdown">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            {secondsLeft === null ? "有效期读取中" : <>二维码剩余 <b>{formatCountdown(secondsLeft)}</b></>}
          </div>
          <button type="button" className="pay-refresh" onClick={onRefreshQr} disabled={refreshing} aria-busy={refreshing}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5"/><path d="M20 4v5h-5"/></svg>
            {refreshing ? "刷新中…" : "刷新二维码"}
          </button>
        </div>
      )}

      {phase === "confirming" && (
        <div className="pay-confirming" role="status">
          <span className="pay-spinner" aria-hidden="true" />
          <h2>正在确认支付结果</h2>
          <p>支付完成后本页将自动更新结果，请勿重复支付。</p>
        </div>
      )}

      {phase === "paid" && (
        <div className="pay-success">
          <div className="pay-success-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg></div>
          <h2>支付成功</h2>
          <p>服务已进入待开通状态，请在用户中心查看进度。</p>
        </div>
      )}

      {phase === "closed" && (
        <div className="pay-closed">
          <h2>二维码已失效</h2>
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

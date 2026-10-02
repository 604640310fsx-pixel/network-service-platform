import { useId, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { WITHDRAW_MIN_FEN, formatYuan, moneyParts, withdrawalGate, type Fen } from "./referralModel";

/** 金额排版：币种 / 主数值 / 小数三级，等宽数字。 */
export function Money({ fen, size }: { fen: Fen; size?: "hero" | "lg" | "md" }) {
  const parts = moneyParts(fen);
  return (
    <span className={`rfc-money${size ? ` is-${size}` : ""}`}>
      <span className="rfc-cur">{parts.sign}</span>
      <span className="rfc-int">{parts.integer}</span>
      <span className="rfc-dec">.{parts.decimal}</span>
    </span>
  );
}

/** 提现入口：功能待接入，任何状态下都不可提交；只说明资格状态。 */
export function WithdrawButton({ balance }: { balance: Fen | null }) {
  const copy = useT().referral;
  const title = balance === null
    ? copy.withdrawTitlePending
    : withdrawalGate(balance).met
      ? copy.withdrawTitleMet
      : copy.withdrawTitleShort(formatYuan(WITHDRAW_MIN_FEN));
  return (
    <button type="button" className="rfc-quiet-btn" disabled aria-disabled="true" title={title}>
      {copy.withdraw}
    </button>
  );
}

/** 「?」说明开关：长规则默认折叠，点击或键盘展开。 */
export function useInfoToggle(label: string, text: string): { button: ReactNode; note: ReactNode } {
  const noteId = useId();
  const copy = useT().referral;
  const [open, setOpen] = useState(false);
  return {
    button: (
      <button
        type="button"
        className="rfc-info"
        aria-expanded={open}
        aria-controls={noteId}
        aria-label={copy.infoLabel(label)}
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
    ),
    note: (
      <p className="rfc-pop-note" id={noteId} hidden={!open}>{text}</p>
    ),
  };
}

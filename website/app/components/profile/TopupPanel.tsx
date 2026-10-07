import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../lib/i18n";
import { createMyTopup, getMyTopup, parseTopupYuan, type TopupIntent } from "../../lib/wallet-api";
import "./topup.css";

type Phase =
  | { readonly kind: "idle" | "creating" }
  | { readonly kind: "waiting"; readonly intent: TopupIntent }
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly message: string; readonly intent?: TopupIntent };

const copy = {
  zh: { title: "钱包充值", amount: "充值金额（元）", submit: "创建充值", creating: "正在创建…",
    checkout: "打开本地测试支付页", waiting: "等待服务端确认到账…", success: "到账已确认，余额正在从服务端刷新。",
    invalid: "请输入大于 0 的金额，最多两位小数。", unavailable: "充值暂不可用，请稍后重试。",
    retry: "重查到账状态", test: "本地测试页仅模拟通知，非真实交易。" },
  en: { title: "Wallet top up", amount: "Amount (CNY)", submit: "Create top up", creating: "Creating…",
    checkout: "Open local test checkout", waiting: "Waiting for server confirmation…", success: "Credit confirmed. Refreshing the balance from the server.",
    invalid: "Enter an amount above zero with at most two decimals.", unavailable: "Top up is unavailable. Please try again.",
    retry: "Check payment status", test: "The local test checkout simulates a notification; no real payment occurs." },
} as const;

export function TopupPanel({ onSucceeded }: { readonly onSucceeded: () => void }) {
  const { lang } = useI18n();
  const t = copy[lang];
  const { csrfToken } = useAuth();
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const attempt = useRef<{ readonly amountFen: number; readonly key: string } | null>(null);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  const pendingId = phase.kind === "waiting" ? phase.intent.topupId : null;
  useEffect(() => {
    if (pendingId === null) return;
    const controller = new AbortController();
    let active = true;
    let confirmed = false;
    const check = async () => {
      try {
        const snapshot = await getMyTopup(pendingId, controller.signal);
        if (!active || confirmed || snapshot.status !== "SUCCEEDED") return;
        confirmed = true;
        attempt.current = null;
        setPhase({ kind: "success" });
        onSucceededRef.current();
      } catch {
        if (!active || controller.signal.aborted) return;
        setPhase((current) => current.kind === "waiting"
          ? { kind: "error", message: t.unavailable, intent: current.intent } : current);
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 1500);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [pendingId, t.unavailable]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountFen = parseTopupYuan(amount);
    if (amountFen === null) { setPhase({ kind: "error", message: t.invalid }); return; }
    if (csrfToken === null) { setPhase({ kind: "error", message: t.unavailable }); return; }
    const key = attempt.current?.amountFen === amountFen ? attempt.current.key : crypto.randomUUID();
    attempt.current = { amountFen, key };
    setPhase({ kind: "creating" });
    try {
      const intent = await createMyTopup(csrfToken, key, amountFen);
      setPhase(intent.status === "SUCCEEDED" ? { kind: "success" } : { kind: "waiting", intent });
      if (intent.status === "SUCCEEDED") {
        attempt.current = null;
        onSucceededRef.current();
      }
    } catch {
      setPhase({ kind: "error", message: t.unavailable });
    }
  };

  return (
    <section className="cc-topup" aria-label={t.title}>
      <h3>{t.title}</h3>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="cc-topup-amount">{t.amount}</label>
        <div className="cc-topup-entry">
          <input id="cc-topup-amount" inputMode="decimal" autoComplete="off" value={amount}
            onChange={(event) => setAmount(event.target.value)} disabled={phase.kind === "creating" || phase.kind === "waiting"} />
          <button type="submit" disabled={phase.kind === "creating" || phase.kind === "waiting"}>
            {phase.kind === "creating" ? t.creating : t.submit}
          </button>
        </div>
      </form>
      {phase.kind === "waiting" && <div className="cc-topup-state" role="status">
        <p>{t.waiting}</p><a href={phase.intent.checkout.url} target="_blank" rel="noopener noreferrer">{t.checkout}</a>
        <small>{t.test}</small>
      </div>}
      {phase.kind === "success" && <p className="cc-topup-state" role="status">{t.success}</p>}
      {phase.kind === "error" && <div className="cc-topup-state" role="alert">
        <p>{phase.message}</p>
        {phase.intent && <button type="button" onClick={() => setPhase({ kind: "waiting", intent: phase.intent! })}>{t.retry}</button>}
      </div>}
    </section>
  );
}

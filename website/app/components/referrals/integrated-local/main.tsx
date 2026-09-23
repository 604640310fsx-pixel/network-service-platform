import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CustomerCenterShell } from "../../customer/CustomerCenterShell";
import { AuthProvider, useAuth } from "../../../lib/auth";
import { ReferralCenterAdapter } from "../ReferralCenterAdapter";
import { REFERRAL_CENTER_DESCRIPTION, REFERRAL_CENTER_TITLE } from "../ReferralCenter";
import "../../../globals.css";
import "./style.css";

type DemoState = {
  readonly demoPassword: string;
  readonly promoters: readonly { email: string }[];
  readonly visitors: readonly { email: string; inviteCode: string }[];
  readonly mail: readonly { email: string; otp: string }[];
};

function Demo() {
  const { status, principal, login, logout } = useAuth();
  const [state, setState] = useState<DemoState | null>(null);
  const [email, setEmail] = useState("promoter-a@example.test");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const read = () => {
      void fetch("/__referral_demo/state", { cache: "no-store" })
        .then((response) => response.json() as Promise<DemoState>)
        .then((value) => { if (active) setState(value); })
        .catch(() => { if (active) setError("本地演示状态读取失败"); });
    };
    read();
    const timer = window.setInterval(read, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (state === null) throw new Error("Demo state unavailable");
      await login(email, state.demoPassword);
    }
    catch { setError("登录失败，请检查演示账号。"); }
    finally { setBusy(false); }
  }

  return <>
    <section className="ril-controls" aria-label="本地演示操作">
      <strong>本地集成演示 · 合成数据 · 非报价</strong>
      <p>真实会话、推荐链接、邀请码注册与候选记录；无真实邮件、支付、佣金余额或提现。</p>
      {status === "authenticated" ? <p>当前账号：{principal?.email} <button onClick={() => void logout()}>退出登录</button></p> :
        <form onSubmit={(event) => void submit(event)}>
          <label>推广人邮箱 <select value={email} onChange={(event) => setEmail(event.target.value)}>
            {state?.promoters.map((item) => <option key={item.email}>{item.email}</option>)}
          </select></label>
          <button type="submit" disabled={busy || status === "checking" || state === null}>登录合成推广人</button>
        </form>}
      <div className="ril-visitors">
        {state?.visitors.map((visitor) => <p key={visitor.email}>访客 {visitor.email} · 邀请码 <code>{visitor.inviteCode}</code></p>)}
      </div>
      <p>请在另一标签页打开下方推荐链接，用对应邮箱和邀请码注册。验证码会显示在这里。</p>
      <div aria-live="polite">{state?.mail.map((item) => <p key={item.email}>本地验证码 {item.email}：<code>{item.otp}</code></p>)}</div>
      {error && <p role="alert">{error}</p>}
    </section>
    {status === "authenticated" && <CustomerCenterShell title={REFERRAL_CENTER_TITLE} description={REFERRAL_CENTER_DESCRIPTION} fill>
      <ReferralCenterAdapter />
    </CustomerCenterShell>}
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><AuthProvider><Demo /></AuthProvider></BrowserRouter></StrictMode>);

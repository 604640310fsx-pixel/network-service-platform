import { useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH } from "./passwordPolicy";

/* WEB-AUTH-01：仅登录页视觉母版。
   本页不发送任何网络请求，不写 Cookie / token / session，不伪造登录成功。
   真实 POST /api/auth/login 接线与 invalid_credentials / busy / rate_limited /
   auth_unavailable 的错误映射留给 WEB-AUTH-02，本页不预先发明另一套 Auth 状态机制。 */

const DEMO_LATENCY_MS = 900;

type FormStatus = "idle" | "submitting";

export function LoginPage() {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const submitting = status === "submitting";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 最小本地校验：只检查输入存在性，密码策略由服务端负责，本页不自行发明。
    if (!email.trim() || !password) {
      setError("请填写邮箱与密码。");
      return;
    }

    // 进入 loading 时不清空既有错误：清空会让错误区消失并使按钮上移，
    // 造成 loading 期间的布局跳动。错误只在新结果到达时被替换。
    setStatus("submitting");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setStatus("idle");
      // 如实说明：登录服务尚未接线，不冒充任何服务端结果。
      setError("登录服务尚未接入，当前页面仅供界面验收。");
    }, DEMO_LATENCY_MS);
  }

  return (
    <AuthShell title="登录客户中心" subtitle="登录后进入服务管理页面。">
      {error && <AuthNotice tone="danger" id={errorId}>{error}</AuthNotice>}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label htmlFor={emailId}>邮箱</label>
          <div className="auth-input-wrap">
            <input
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>密码</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="current-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="请输入密码"
              value={password}
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={revealPassword}
              aria-controls={passwordId}
              disabled={submitting}
              onClick={() => setRevealPassword((current) => !current)}
            >
              <RevealIcon revealed={revealPassword} />
            </button>
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "正在登录…" : "登录"}
        </button>
      </form>

      <div className="auth-foot">
        <button type="button" className="auth-pending-link" disabled aria-disabled="true" title="忘记密码待接入">
          忘记密码（待接入）
        </button>
      </div>

      <p className="auth-switch">
        没有账号？<Link to="/register">去注册</Link>
      </p>
    </AuthShell>
  );
}

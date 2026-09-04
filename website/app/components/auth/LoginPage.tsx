import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LoginRequestError } from "../../lib/auth-errors";
import { useAuth } from "../../lib/auth";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH } from "./passwordPolicy";

type FormStatus = "idle" | "submitting";

function loginErrorMessage(error: unknown): string {
  if (error instanceof LoginRequestError) {
    switch (error.code) {
      case "invalid_credentials":
        return "邮箱或密码错误";
      case "busy":
        return "服务繁忙，请稍后重试";
      case "rate_limited":
        return "尝试次数过多，请稍后重试";
      case "auth_unavailable":
        return "登录服务暂时不可用，请稍后重试";
      case "login_failed":
        break;
    }
  }
  return "登录失败，请稍后重试";
}

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const submitting = status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 最小本地校验：只检查输入存在性，密码策略由服务端负责，本页不自行发明。
    if (!email.trim() || !password) {
      setError("请填写邮箱与密码。");
      return;
    }

    setError(null);
    setStatus("submitting");
    try {
      await login(email, password);
      navigate("/dashboard", { replace: true });
    } catch (loginError: unknown) {
      setError(loginErrorMessage(loginError));
    } finally {
      setStatus("idle");
    }
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

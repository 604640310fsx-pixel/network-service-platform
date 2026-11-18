import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LoginRequestError } from "../../lib/auth-errors";
import { useAuth } from "../../lib/auth";
import { useT, type Messages } from "../../lib/i18n";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH } from "./passwordPolicy";
import { registrationCompleteFromLocationState } from "./registrationFlow";

type FormStatus = "idle" | "submitting";

function loginErrorMessage(error: unknown, messages: Messages["login"]["errors"]): string {
  if (error instanceof LoginRequestError) {
    switch (error.code) {
      case "invalid_credentials":
        return messages.invalidCredentials;
      case "busy":
        return messages.busy;
      case "rate_limited":
        return messages.rateLimited;
      case "auth_unavailable":
        return messages.unavailable;
      case "login_failed":
        break;
    }
  }
  return messages.generic;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const t = useT();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // 注册成功跳转时只带一个布尔标记；读取后立即从历史记录中清除，刷新不再显示。
  const [registered, setRegistered] = useState(() =>
    registrationCompleteFromLocationState(location.state),
  );

  useEffect(() => {
    if (registrationCompleteFromLocationState(location.state)) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  const submitting = status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 最小本地校验：只检查输入存在性，密码策略由服务端负责，本页不自行发明。
    if (!email.trim() || !password) {
      setError(t.login.fillBoth);
      return;
    }

    setError(null);
    setRegistered(false);
    setStatus("submitting");
    try {
      await login(email, password);
      navigate("/dashboard", { replace: true });
    } catch (loginError: unknown) {
      setError(loginErrorMessage(loginError, t.login.errors));
    } finally {
      setStatus("idle");
    }
  }

  return (
    <AuthShell title={t.login.title} subtitle={t.login.subtitle}>
      {registered && !error && <AuthNotice tone="neutral">{t.login.registeredNotice}</AuthNotice>}
      {error && <AuthNotice tone="danger" id={errorId}>{error}</AuthNotice>}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label htmlFor={emailId}>{t.common.emailLabel}</label>
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
              placeholder={t.common.emailPlaceholder}
              value={email}
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>{t.login.passwordLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="current-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={t.login.passwordPlaceholder}
              value={password}
              disabled={submitting}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealPassword ? t.common.hidePassword : t.common.showPassword}
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
          {submitting ? t.login.submitting : t.login.submit}
        </button>
      </form>

      <div className="auth-foot">
        <Link className="auth-foot-link" to="/forgot-password">{t.login.forgotPassword}</Link>
      </div>

      <p className="auth-switch">
        {t.login.noAccount}<Link to="/register">{t.login.toRegister}</Link>
      </p>
    </AuthShell>
  );
}

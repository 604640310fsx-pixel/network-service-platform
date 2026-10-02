import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { PasswordResetApiError, requestPasswordReset } from "../../lib/password-reset-api";
import { AuthNotice, AuthShell } from "./AuthShell";
import {
  RESET_REQUEST_SENT_NOTICE,
  resetRequestErrorMessage,
  validateResetEmail,
} from "./passwordResetModel";

type Status = "idle" | "submitting" | "sent";

export function ForgotPasswordPage() {
  const emailId = useId();
  const emailErrorId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const submitting = status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const invalid = validateResetEmail(email);
    setEmailError(invalid);
    if (invalid) return;

    setError(null);
    setStatus("submitting");
    try {
      await requestPasswordReset(email);
      // 无论邮箱是否注册都显示同一提示，不泄露账户是否存在。
      setStatus("sent");
    } catch (requestError: unknown) {
      setError(resetRequestErrorMessage(
        requestError instanceof PasswordResetApiError ? requestError.code : "request_failed",
      ));
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <AuthShell title="查收重置邮件" subtitle="重置链接 30 分钟内有效，且只能使用一次。">
        <AuthNotice tone="neutral">{RESET_REQUEST_SENT_NOTICE}</AuthNotice>
        <p className="auth-switch">
          <Link to="/login">返回登录</Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="忘记密码" subtitle="输入注册邮箱，我们会发送重置密码的链接。">
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
              aria-invalid={emailError !== null}
              aria-describedby={emailError !== null ? emailErrorId : error ? errorId : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
            />
          </div>
          {emailError !== null && (
            <p className="auth-hint is-danger" id={emailErrorId} aria-live="polite">{emailError}</p>
          )}
        </div>

        <button type="submit" className="auth-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "正在发送…" : "发送重置链接"}
        </button>
      </form>

      <p className="auth-switch">
        想起密码了？<Link to="/login">返回登录</Link>
      </p>
    </AuthShell>
  );
}

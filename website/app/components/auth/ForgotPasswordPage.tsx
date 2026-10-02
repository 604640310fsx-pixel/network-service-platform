import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { PasswordResetApiError, requestPasswordReset } from "../../lib/password-reset-api";
import { AuthNotice, AuthShell } from "./AuthShell";
import { resetRequestErrorMessage, validateResetEmail } from "./passwordResetModel";

type Status = "idle" | "submitting" | "sent";

export function ForgotPasswordPage() {
  const t = useT();
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
    const invalid = validateResetEmail(email, t.forgot.validation);
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
        t.forgot.errors,
      ));
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <AuthShell title={t.forgot.sentTitle} subtitle={t.forgot.sentSubtitle}>
        <AuthNotice tone="neutral">{t.forgot.sentNotice}</AuthNotice>
        <p className="auth-switch">
          <Link to="/login">{t.common.backToLogin}</Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.forgot.title} subtitle={t.forgot.subtitle}>
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
          {submitting ? t.forgot.sending : t.forgot.submit}
        </button>
      </form>

      <p className="auth-switch">
        {t.forgot.remembered}<Link to="/login">{t.common.backToLogin}</Link>
      </p>
    </AuthShell>
  );
}

import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useT } from "../../lib/i18n";
import {
  confirmPasswordReset,
  PasswordResetApiError,
  resetTokenFromSearch,
} from "../../lib/password-reset-api";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "./passwordPolicy";
import {
  resetConfirmFailure,
  validateResetPassword,
  type ResetPasswordErrors,
} from "./passwordResetModel";

type Status = "idle" | "submitting" | "done" | "invalid";

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const t = useT();
  // 令牌只在内存中保留；读取后立即从地址栏移除，避免留在历史记录或被转发。
  const [token] = useState(() => resetTokenFromSearch(searchParams.toString()));
  const passwordId = useId();
  const passwordHintId = useId();
  const passwordErrorId = useId();
  const confirmId = useId();
  const confirmErrorId = useId();
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ResetPasswordErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(token === null ? "invalid" : "idle");
  const submitting = status === "submitting";

  useEffect(() => {
    if (searchParams.has("token")) navigate("/reset-password", { replace: true });
  }, [navigate, searchParams]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || token === null) return;
    const errors = validateResetPassword(password, confirmPassword, POLICY, t.reset.validation);
    setFieldErrors(errors);
    if (errors.password || errors.confirmPassword) return;

    setError(null);
    setStatus("submitting");
    try {
      await confirmPasswordReset(token, password);
      setPassword("");
      setConfirmPassword("");
      setStatus("done");
    } catch (confirmError: unknown) {
      const failure = resetConfirmFailure(
        confirmError instanceof PasswordResetApiError ? confirmError.code : "request_failed",
        POLICY,
        t.reset.errors,
      );
      if (failure.kind === "invalid_token") {
        setStatus("invalid");
        return;
      }
      if (failure.kind === "field") setFieldErrors({ password: failure.text });
      else setError(failure.text);
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <AuthShell title={t.reset.doneTitle} subtitle={t.reset.doneSubtitle}>
        <AuthNotice tone="neutral">{t.reset.doneNotice}</AuthNotice>
        <p className="auth-switch">
          <Link to="/login">{t.common.toLogin}</Link>
        </p>
      </AuthShell>
    );
  }

  if (status === "invalid") {
    return (
      <AuthShell title={t.reset.invalidTitle} subtitle={t.reset.invalidSubtitle}>
        <AuthNotice tone="danger">
          {token === null ? t.reset.linkIncomplete : t.reset.linkExpired}
        </AuthNotice>
        <p className="auth-switch">
          <Link to="/forgot-password">{t.reset.requestAgain}</Link>
        </p>
      </AuthShell>
    );
  }

  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const confirmError = fieldErrors.confirmPassword ?? (confirmMismatch ? t.reset.validation.confirmMismatch : null);

  return (
    <AuthShell title={t.reset.title} subtitle={t.reset.subtitle}>
      {error && <AuthNotice tone="danger" id={errorId}>{error}</AuthNotice>}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label htmlFor={passwordId}>{t.reset.passwordLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={t.reset.passwordPlaceholder}
              value={password}
              disabled={submitting}
              aria-invalid={fieldErrors.password !== undefined}
              aria-describedby={fieldErrors.password !== undefined ? `${passwordHintId} ${passwordErrorId}` : passwordHintId}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors({});
              }}
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
          <p className="auth-hint" id={passwordHintId}>
            {t.reset.passwordHint(REGISTRATION_PASSWORD_MIN_LENGTH)}
          </p>
          {fieldErrors.password !== undefined && (
            <p className="auth-hint is-danger" id={passwordErrorId} aria-live="polite">{fieldErrors.password}</p>
          )}
        </div>

        <div className="auth-field">
          <label htmlFor={confirmId}>{t.reset.confirmLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={confirmId}
              name="confirmPassword"
              type={revealConfirm ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={t.reset.confirmPlaceholder}
              value={confirmPassword}
              disabled={submitting}
              aria-invalid={confirmError !== null}
              aria-describedby={confirmError !== null ? confirmErrorId : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setFieldErrors((current) => ({ ...current, confirmPassword: undefined }));
              }}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealConfirm ? t.common.hideConfirmPassword : t.common.showConfirmPassword}
              aria-pressed={revealConfirm}
              aria-controls={confirmId}
              disabled={submitting}
              onClick={() => setRevealConfirm((current) => !current)}
            >
              <RevealIcon revealed={revealConfirm} />
            </button>
          </div>
          {confirmError !== null && (
            <p className="auth-hint is-danger" id={confirmErrorId} aria-live="polite">{confirmError}</p>
          )}
        </div>

        <button type="submit" className="auth-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? t.reset.submitting : t.reset.submit}
        </button>
      </form>

      <p className="auth-switch">
        <Link to="/login">{t.common.backToLogin}</Link>
      </p>
    </AuthShell>
  );
}

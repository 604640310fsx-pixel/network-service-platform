import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  confirmPasswordReset,
  PasswordResetApiError,
  resetTokenFromSearch,
} from "../../lib/password-reset-api";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "./passwordPolicy";
import {
  RESET_DONE_NOTICE,
  resetConfirmFailure,
  validateResetPassword,
  type ResetPasswordErrors,
} from "./passwordResetModel";

type Status = "idle" | "submitting" | "done" | "invalid";

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
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
    const errors = validateResetPassword(password, confirmPassword, POLICY);
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
      <AuthShell title="密码已重置" subtitle="所有设备上的旧登录均已失效。">
        <AuthNotice tone="neutral">{RESET_DONE_NOTICE}</AuthNotice>
        <p className="auth-switch">
          <Link to="/login">去登录</Link>
        </p>
      </AuthShell>
    );
  }

  if (status === "invalid") {
    return (
      <AuthShell title="链接无效" subtitle="重置链接 30 分钟内有效，且只能使用一次。">
        <AuthNotice tone="danger">
          {token === null ? "重置链接不完整，请从邮件中重新打开链接。" : "该重置链接已过期或已被使用。"}
        </AuthNotice>
        <p className="auth-switch">
          <Link to="/forgot-password">重新申请</Link>
        </p>
      </AuthShell>
    );
  }

  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const confirmError = fieldErrors.confirmPassword ?? (confirmMismatch ? "两次输入的新密码不一致。" : null);

  return (
    <AuthShell title="设置新密码" subtitle="重置成功后，所有设备上的旧登录都会失效。">
      {error && <AuthNotice tone="danger" id={errorId}>{error}</AuthNotice>}

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label htmlFor={passwordId}>新密码</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="请输入新密码"
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
              aria-label={revealPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={revealPassword}
              aria-controls={passwordId}
              disabled={submitting}
              onClick={() => setRevealPassword((current) => !current)}
            >
              <RevealIcon revealed={revealPassword} />
            </button>
          </div>
          <p className="auth-hint" id={passwordHintId}>
            至少 {REGISTRATION_PASSWORD_MIN_LENGTH} 个字符，最终以服务端校验为准。
          </p>
          {fieldErrors.password !== undefined && (
            <p className="auth-hint is-danger" id={passwordErrorId} aria-live="polite">{fieldErrors.password}</p>
          )}
        </div>

        <div className="auth-field">
          <label htmlFor={confirmId}>确认新密码</label>
          <div className="auth-input-wrap">
            <input
              id={confirmId}
              name="confirmPassword"
              type={revealConfirm ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="请再次输入新密码"
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
              aria-label={revealConfirm ? "隐藏确认密码" : "显示确认密码"}
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
          {submitting ? "正在重置…" : "重置密码"}
        </button>
      </form>

      <p className="auth-switch">
        <Link to="/login">返回登录</Link>
      </p>
    </AuthShell>
  );
}

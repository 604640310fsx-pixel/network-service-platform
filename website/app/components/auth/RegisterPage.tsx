import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  completeRegistration,
  canonicalInviteCode,
  inviteCodeFromSearch,
  referralSourceCodeFromSearch,
  RegistrationApiError,
  resendRegistrationCode,
  startRegistration,
  verifyRegistrationCode,
} from "../../lib/registration-api";
import { useT, type Messages } from "../../lib/i18n";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "./passwordPolicy";
import {
  hasFieldErrors,
  registrationErrorNotice,
  REGISTRATION_SUCCESS_NAVIGATION,
  runRegistrationSubmission,
  validateRegistrationSubmission,
  type RegistrationFieldErrors,
  type RegistrationPhase,
} from "./registrationFlow";

/* 注册流程严格接入既有服务端状态机。registration token 只保存在组件内存，
   不写 Cookie / storage、不记录明文邀请码或验证码，也不自动建立登录 Session。 */

const VERIFICATION_COUNTDOWN_SECONDS = 60;

type FormStatus = "idle" | "sending" | "submitting";
type Notice = { tone: "danger" | "neutral"; text: string; loginLink?: boolean };

function registrationErrorNoticeFor(error: unknown, messages: Messages["register"]["errors"]): Notice {
  const code = error instanceof RegistrationApiError ? error.code : null;
  return { tone: "danger", ...registrationErrorNotice(code, messages) };
}

export function RegisterPage() {
  const navigate = useNavigate();
  const t = useT();
  const emailId = useId();
  const codeId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const inviteId = useId();
  const noticeId = useId();
  const passwordHintId = useId();
  const confirmHintId = useId();
  const codeErrorId = useId();
  const passwordErrorId = useId();

  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(() => inviteCodeFromSearch(window.location.search) ?? "");
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [phase, setPhase] = useState<RegistrationPhase>("not_started");
  const [registrationToken, setRegistrationToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RegistrationFieldErrors>({});
  const [countdown, setCountdown] = useState(0);
  const [referralSourceCode] = useState(() =>
    referralSourceCodeFromSearch(window.location.search),
  );

  const busy = status !== "idle";
  const identityLocked = phase !== "not_started";
  const completed = phase === "completed";
  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const confirmError = fieldErrors.confirmPassword ?? (confirmMismatch ? t.register.validation.confirmMismatch : null);

  function clearFieldError(field: keyof RegistrationFieldErrors) {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  useEffect(() => {
    if (countdown <= 0) return;
    const tick = window.setTimeout(() => setCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [countdown]);

  async function handleSendCode() {
    if (
      countdown > 0 ||
      busy ||
      phase === "verified" ||
      phase === "completed"
    ) {
      return;
    }
    setNotice(null);
    setStatus("sending");
    try {
      if (phase === "not_started") {
        const canonicalEmail = email.trim();
        const canonicalInvite = canonicalInviteCode(inviteCode);
        if (canonicalEmail === "" || canonicalInvite === "") {
          setNotice({ tone: "danger", text: t.register.fillEmailAndInvite });
          return;
        }
        const token = await startRegistration(
          canonicalEmail,
          canonicalInvite,
          referralSourceCode,
        );
        setEmail(canonicalEmail);
        setInviteCode(canonicalInvite);
        setRegistrationToken(token);
        setPhase("awaiting_verification");
      } else {
        if (registrationToken === null) {
          setNotice({ tone: "danger", text: t.register.stateExpired });
          return;
        }
        await resendRegistrationCode(registrationToken);
      }
      setCountdown(VERIFICATION_COUNTDOWN_SECONDS);
      setNotice({ tone: "neutral", text: t.register.codeSent });
    } catch (error) {
      setNotice(registrationErrorNoticeFor(error, t.register.errors));
    } finally {
      setStatus("idle");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || completed) return;

    if (phase === "not_started" || registrationToken === null) {
      setNotice({ tone: "danger", text: t.register.sendCodeFirst });
      return;
    }
    // 请求前先做本地格式校验；不合格时不发出验证或完成请求。
    const errors = validateRegistrationSubmission(
      { phase, verificationCode, password, confirmPassword },
      { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
      t.register.validation,
    );
    setFieldErrors(errors);
    if (hasFieldErrors(errors)) {
      setNotice(null);
      return;
    }

    setStatus("submitting");
    setNotice(null);
    const result = await runRegistrationSubmission(
      { phase, registrationToken, verificationCode, password, confirmPassword },
      { verify: verifyRegistrationCode, complete: completeRegistration },
    );
    if (result.kind === "failed") {
      // 留在注册页：验证码已通过时保留新 token，下次只重试完成步骤。
      setRegistrationToken(result.registrationToken);
      setPhase(result.phase);
      setNotice(registrationErrorNoticeFor(result.error, t.register.errors));
      setStatus("idle");
      return;
    }
    // 仅在注册完成后清除敏感状态，并以替换历史的方式前往登录页。
    setRegistrationToken(null);
    setPhase("completed");
    setCountdown(0);
    setVerificationCode("");
    setInviteCode("");
    setPassword("");
    setConfirmPassword("");
    setStatus("idle");
    navigate(REGISTRATION_SUCCESS_NAVIGATION.to, REGISTRATION_SUCCESS_NAVIGATION.options);
  }

  return (
    <AuthShell title={t.register.title} subtitle={t.register.subtitle} wide>
      {referralSourceCode !== null && (
        <AuthNotice tone="neutral">{t.register.referralNotice}</AuthNotice>
      )}
      {notice && (
        <AuthNotice tone={notice.tone} id={noticeId}>
          {notice.text}
          {notice.loginLink && <> <Link to="/login">{t.common.toLogin}</Link></>}
        </AuthNotice>
      )}

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
              disabled={busy || identityLocked}
              aria-describedby={notice ? noticeId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor={codeId}>{t.register.codeLabel}</label>
          <div className="auth-code-row">
            <div className="auth-input-wrap">
              <input
                id={codeId}
                name="verificationCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder={t.register.codePlaceholder}
                value={verificationCode}
                maxLength={6}
                disabled={busy || phase !== "awaiting_verification"}
                aria-invalid={fieldErrors.verificationCode !== undefined}
                aria-describedby={fieldErrors.verificationCode !== undefined ? codeErrorId : undefined}
                onChange={(event) => {
                  setVerificationCode(event.target.value);
                  clearFieldError("verificationCode");
                }}
              />
            </div>
            <button
              type="button"
              className="auth-code-button"
              disabled={
                busy ||
                countdown > 0 ||
                phase === "verified" ||
                completed
              }
              aria-disabled={
                busy ||
                countdown > 0 ||
                phase === "verified" ||
                completed
              }
              onClick={() => void handleSendCode()}
            >
              {status === "sending"
                ? t.register.sending
                : countdown > 0
                  ? t.register.resendIn(countdown)
                  : phase === "not_started"
                    ? t.register.sendCode
                    : t.register.resendCode}
            </button>
          </div>
          {fieldErrors.verificationCode !== undefined && (
            <p className="auth-hint is-danger" id={codeErrorId} aria-live="polite">
              {fieldErrors.verificationCode}
            </p>
          )}
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>{t.register.passwordLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={t.register.passwordPlaceholder}
              value={password}
              disabled={busy || completed}
              aria-invalid={fieldErrors.password !== undefined}
              aria-describedby={
                fieldErrors.password !== undefined
                  ? `${passwordHintId} ${passwordErrorId}`
                  : passwordHintId
              }
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError("password");
                clearFieldError("confirmPassword");
              }}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealPassword ? t.common.hidePassword : t.common.showPassword}
              aria-pressed={revealPassword}
              aria-controls={passwordId}
              disabled={busy || completed}
              onClick={() => setRevealPassword((current) => !current)}
            >
              <RevealIcon revealed={revealPassword} />
            </button>
          </div>
          <p className="auth-hint" id={passwordHintId}>
            {t.register.passwordHint(REGISTRATION_PASSWORD_MIN_LENGTH)}
          </p>
          {fieldErrors.password !== undefined && (
            <p className="auth-hint is-danger" id={passwordErrorId} aria-live="polite">
              {fieldErrors.password}
            </p>
          )}
        </div>

        <div className="auth-field">
          <label htmlFor={confirmId}>{t.register.confirmLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={confirmId}
              name="confirmPassword"
              type={revealConfirm ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder={t.register.confirmPlaceholder}
              value={confirmPassword}
              disabled={busy || completed}
              aria-invalid={confirmError !== null}
              aria-describedby={confirmError !== null ? confirmHintId : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                clearFieldError("confirmPassword");
              }}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealConfirm ? t.common.hideConfirmPassword : t.common.showConfirmPassword}
              aria-pressed={revealConfirm}
              aria-controls={confirmId}
              disabled={busy || completed}
              onClick={() => setRevealConfirm((current) => !current)}
            >
              <RevealIcon revealed={revealConfirm} />
            </button>
          </div>
          {/* 始终占位，避免不一致提示出现/消失时推动下方字段。 */}
          <p className="auth-hint is-danger" id={confirmHintId} aria-live="polite">
            {confirmError ?? " "}
          </p>
        </div>

        <div className="auth-field">
          <label htmlFor={inviteId}>{t.register.inviteLabel}</label>
          <div className="auth-input-wrap">
            <input
              id={inviteId}
              name="inviteCode"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={34}
              placeholder={t.register.invitePlaceholder}
              value={inviteCode}
              disabled={busy || identityLocked}
              onChange={(event) => setInviteCode(event.target.value)}
            />
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={busy || completed} aria-busy={status === "submitting"}>
          {completed ? t.register.completed : status === "submitting" ? t.register.submitting : t.register.submit}
        </button>
      </form>

      <p className="auth-switch">
        {t.register.haveAccount}<Link to="/login">{t.common.toLogin}</Link>
      </p>
    </AuthShell>
  );
}

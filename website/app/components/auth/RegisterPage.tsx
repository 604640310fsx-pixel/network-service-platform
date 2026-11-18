import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
  validateRegistrationStart,
  validateRegistrationSubmission,
  type RegistrationFieldErrors,
  type RegistrationPhase,
  type RegistrationStage,
} from "./registrationFlow";

/* 注册流程严格接入既有服务端状态机。registration token 只保存在组件内存，
   不写 Cookie / storage、不记录明文邀请码或验证码，也不自动建立登录 Session。 */

const VERIFICATION_COUNTDOWN_SECONDS = 60;

type FormStatus = "idle" | "sending" | "submitting";
// stage 记录提示来自哪一步请求，便于用户修改相关输入时只清除对应的过期提示。
type Notice = {
  tone: "danger" | "neutral";
  text: string;
  loginLink?: boolean;
  restart?: boolean;
  stage?: RegistrationStage | "local";
};
type FocusTarget = keyof RegistrationFieldErrors | "sendCode";

// 与页面字段的 DOM 顺序一致，用于聚焦第一个有误的字段。
const FIELD_ORDER: readonly (keyof RegistrationFieldErrors)[] = [
  "email",
  "verificationCode",
  "password",
  "confirmPassword",
  "inviteCode",
];

function firstInvalidField(errors: RegistrationFieldErrors): keyof RegistrationFieldErrors | null {
  return FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}

function registrationErrorNoticeFor(
  error: unknown,
  stage: RegistrationStage,
  messages: Messages["register"]["errors"],
): { notice: Notice; reset: boolean } {
  const code = error instanceof RegistrationApiError ? error.code : null;
  const mapped = registrationErrorNotice(code, stage, messages);
  return {
    notice: {
      tone: "danger",
      text: mapped.text,
      loginLink: mapped.loginLink,
      restart: mapped.recovery === "restart",
      stage,
    },
    reset: mapped.recovery === "reset",
  };
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
  const emailErrorId = useId();
  const inviteErrorId = useId();

  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const sendCodeRef = useRef<HTMLButtonElement>(null);
  // 同步的在途标记：防止同一帧内的重复点击在 busy 状态生效前再次发请求。
  const inFlight = useRef(false);
  // 渲染后再聚焦，确保目标字段已解除 disabled。
  const pendingFocus = useRef<FocusTarget | null>(null);

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

  function requestFocus(target: FocusTarget | null) {
    pendingFocus.current = target;
  }

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = {
      email: emailRef,
      verificationCode: codeRef,
      password: passwordRef,
      confirmPassword: confirmRef,
      inviteCode: inviteRef,
      sendCode: sendCodeRef,
    }[target].current;
    element?.focus();
  });

  // 只清除由指定请求阶段产生的错误提示；中性提示（如验证码已发送）保留。
  function clearNoticeFrom(stages: readonly (RegistrationStage | "local")[]) {
    setNotice((current) =>
      current !== null &&
      current.tone === "danger" &&
      current.stage !== undefined &&
      stages.includes(current.stage)
        ? null
        : current,
    );
  }

  // 回到发送验证码之前：丢弃已不可用的 token 与验证码，保留邮箱、邀请码和密码输入。
  function resetToStart() {
    setRegistrationToken(null);
    setPhase("not_started");
    setCountdown(0);
    setVerificationCode("");
    clearFieldError("verificationCode");
  }

  function showFailure(error: unknown, stage: RegistrationStage) {
    const { notice: failure, reset } = registrationErrorNoticeFor(error, stage, t.register.errors);
    if (reset) {
      resetToStart();
      requestFocus("sendCode");
    }
    setNotice(failure);
  }

  function handleRestart() {
    if (inFlight.current) return;
    resetToStart();
    setNotice(null);
    requestFocus("sendCode");
  }

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
      inFlight.current ||
      countdown > 0 ||
      phase === "verified" ||
      phase === "completed"
    ) {
      return;
    }
    const stage: RegistrationStage = phase === "not_started" ? "start" : "resend";
    let canonicalEmail = "";
    let canonicalInvite = "";
    if (stage === "start") {
      // 发送验证码只校验邮箱和邀请码，不要求验证码或密码；格式不符时不发请求。
      const errors = validateRegistrationStart({ email, inviteCode }, t.register.validation);
      setFieldErrors((current) => {
        const next = { ...current, ...errors };
        if (errors.email === undefined) delete next.email;
        if (errors.inviteCode === undefined) delete next.inviteCode;
        return next;
      });
      if (hasFieldErrors(errors)) {
        setNotice(null);
        requestFocus(firstInvalidField(errors));
        return;
      }
      canonicalEmail = email.trim();
      canonicalInvite = canonicalInviteCode(inviteCode);
    }
    const resendToken = registrationToken;
    if (stage === "resend" && resendToken === null) {
      resetToStart();
      setNotice({ tone: "danger", text: t.register.stateExpired, stage: "resend" });
      requestFocus("sendCode");
      return;
    }

    inFlight.current = true;
    setNotice(null);
    setStatus("sending");
    try {
      if (stage === "start") {
        const token = await startRegistration(
          canonicalEmail,
          canonicalInvite,
          referralSourceCode,
        );
        setEmail(canonicalEmail);
        setInviteCode(canonicalInvite);
        setRegistrationToken(token);
        setPhase("awaiting_verification");
        requestFocus("verificationCode");
      } else if (resendToken !== null) {
        await resendRegistrationCode(resendToken);
      }
      setCountdown(VERIFICATION_COUNTDOWN_SECONDS);
      // 中性 200 不代表邮件已投递：文案保持“如果有效则发送”的条件表述。
      setNotice({ tone: "neutral", text: t.register.codeSent });
    } catch (error) {
      showFailure(error, stage);
    } finally {
      inFlight.current = false;
      setStatus("idle");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || completed) return;

    if (phase === "not_started" || registrationToken === null) {
      // 尚未发送验证码：同时指出邮箱 / 邀请码的格式问题，其余字段此时不校验。
      const errors = validateRegistrationStart({ email, inviteCode }, t.register.validation);
      setFieldErrors(errors);
      setNotice({ tone: "danger", text: t.register.sendCodeFirst, stage: "local" });
      requestFocus(firstInvalidField(errors) ?? "sendCode");
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
      requestFocus(firstInvalidField(errors));
      return;
    }

    inFlight.current = true;
    setStatus("submitting");
    setNotice(null);
    const result = await runRegistrationSubmission(
      { phase, registrationToken, verificationCode, password, confirmPassword },
      { verify: verifyRegistrationCode, complete: completeRegistration },
    );
    inFlight.current = false;
    if (result.kind === "failed") {
      // 留在注册页：验证码已通过时保留新 token，下次只重试完成步骤。
      setRegistrationToken(result.registrationToken);
      setPhase(result.phase);
      // 失败发生在哪一步由返回的 phase 决定：仍待验证即验证码步骤，否则是完成步骤。
      showFailure(result.error, result.phase === "awaiting_verification" ? "verify" : "complete");
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

  const describedBy = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <AuthShell title={t.register.title} subtitle={t.register.subtitle} wide>
      {referralSourceCode !== null && (
        <AuthNotice tone="neutral">{t.register.referralNotice}</AuthNotice>
      )}
      {notice && (
        <AuthNotice tone={notice.tone} id={noticeId}>
          {notice.text}
          {notice.loginLink && <> <Link to="/login">{t.common.toLogin}</Link></>}
          {notice.restart && (
            <>
              {" "}
              <button type="button" className="auth-notice-action" disabled={busy} onClick={handleRestart}>
                {t.register.restart}
              </button>
            </>
          )}
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
              ref={emailRef}
              value={email}
              disabled={busy || identityLocked}
              aria-invalid={fieldErrors.email !== undefined}
              aria-describedby={describedBy(
                fieldErrors.email !== undefined && emailErrorId,
                notice !== null && noticeId,
              )}
              onChange={(event) => {
                setEmail(event.target.value);
                clearFieldError("email");
                clearNoticeFrom(["start", "local"]);
              }}
            />
          </div>
          {fieldErrors.email !== undefined && (
            <p className="auth-hint is-danger" id={emailErrorId} aria-live="polite">
              {fieldErrors.email}
            </p>
          )}
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
                ref={codeRef}
                value={verificationCode}
                maxLength={6}
                disabled={busy || phase !== "awaiting_verification"}
                aria-invalid={fieldErrors.verificationCode !== undefined}
                aria-describedby={fieldErrors.verificationCode !== undefined ? codeErrorId : undefined}
                onChange={(event) => {
                  setVerificationCode(event.target.value);
                  clearFieldError("verificationCode");
                  clearNoticeFrom(["verify", "resend"]);
                }}
              />
            </div>
            <button
              ref={sendCodeRef}
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
              ref={passwordRef}
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
                clearNoticeFrom(["complete"]);
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
              ref={confirmRef}
              value={confirmPassword}
              disabled={busy || completed}
              aria-invalid={confirmError !== null}
              aria-describedby={confirmError !== null ? confirmHintId : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                clearFieldError("confirmPassword");
                clearNoticeFrom(["complete"]);
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
              ref={inviteRef}
              value={inviteCode}
              disabled={busy || identityLocked}
              aria-invalid={fieldErrors.inviteCode !== undefined}
              aria-describedby={describedBy(
                fieldErrors.inviteCode !== undefined && inviteErrorId,
                notice !== null && notice.stage === "start" && noticeId,
              )}
              onChange={(event) => {
                setInviteCode(event.target.value);
                clearFieldError("inviteCode");
                clearNoticeFrom(["start", "local"]);
              }}
            />
          </div>
          {fieldErrors.inviteCode !== undefined && (
            <p className="auth-hint is-danger" id={inviteErrorId} aria-live="polite">
              {fieldErrors.inviteCode}
            </p>
          )}
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

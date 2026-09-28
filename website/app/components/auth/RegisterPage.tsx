import { useEffect, useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "./passwordPolicy";

/* 注册流程严格接入既有服务端状态机。registration token 只保存在组件内存，
   不写 Cookie / storage、不记录明文邀请码或验证码，也不自动建立登录 Session。 */

const VERIFICATION_COUNTDOWN_SECONDS = 60;

type FormStatus = "idle" | "sending" | "submitting";
type RegistrationPhase =
  | "not_started"
  | "awaiting_verification"
  | "verified"
  | "completed";
type Notice = { tone: "danger" | "neutral"; text: string };

function registrationErrorMessage(error: unknown): string {
  if (!(error instanceof RegistrationApiError)) {
    return "注册服务暂时不可用，请稍后重试。";
  }
  switch (error.code) {
    case "rate_limited":
      return "请求过于频繁，请稍后再试。";
    case "password_policy_violation":
      return "密码不符合安全要求，请检查后重试。";
    case "invalid_or_expired":
      return "注册信息无效或已过期，请重新开始。";
    case "invalid_request":
      return "请检查填写内容后重试。";
    default:
      return "暂时无法完成注册，请稍后重试。";
  }
}

export function RegisterPage() {
  const emailId = useId();
  const codeId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const inviteId = useId();
  const noticeId = useId();
  const passwordHintId = useId();
  const confirmHintId = useId();

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
  const [countdown, setCountdown] = useState(0);
  const [referralSourceCode] = useState(() =>
    referralSourceCodeFromSearch(window.location.search),
  );

  const busy = status !== "idle";
  const identityLocked = phase !== "not_started";
  const completed = phase === "completed";
  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;

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
          setNotice({ tone: "danger", text: "请先填写邮箱和邀请码。" });
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
          setNotice({
            tone: "danger",
            text: "注册状态已失效，请刷新页面后重新开始。",
          });
          return;
        }
        await resendRegistrationCode(registrationToken);
      }
      setCountdown(VERIFICATION_COUNTDOWN_SECONDS);
      setNotice({
        tone: "neutral",
        text: "如果邀请码有效且可用于该邮箱，验证码将发送到该邮箱，请注意查收。",
      });
    } catch (error) {
      setNotice({ tone: "danger", text: registrationErrorMessage(error) });
    } finally {
      setStatus("idle");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || completed) return;

    if (phase === "not_started" || registrationToken === null) {
      setNotice({ tone: "danger", text: "请先发送并获取邮箱验证码。" });
      return;
    }
    if (
      (phase === "awaiting_verification" && verificationCode.trim() === "") ||
      !password ||
      !confirmPassword
    ) {
      setNotice({ tone: "danger", text: "请填写验证码和密码后再提交。" });
      return;
    }
    if (password !== confirmPassword) {
      setNotice({ tone: "danger", text: "两次输入的密码不一致。" });
      return;
    }

    setStatus("submitting");
    setNotice(null);
    let currentToken = registrationToken;
    try {
      if (phase === "awaiting_verification") {
        currentToken = await verifyRegistrationCode(
          currentToken,
          verificationCode.trim(),
        );
        setRegistrationToken(currentToken);
        setPhase("verified");
      }
      await completeRegistration(
        currentToken,
        password,
        confirmPassword,
      );
      setRegistrationToken(null);
      setPhase("completed");
      setCountdown(0);
      setVerificationCode("");
      setInviteCode("");
      setPassword("");
      setConfirmPassword("");
      setNotice({
        tone: "neutral",
        text: "注册完成。现在可以前往登录客户中心。",
      });
    } catch (error) {
      setNotice({ tone: "danger", text: registrationErrorMessage(error) });
    } finally {
      setStatus("idle");
    }
  }

  return (
    <AuthShell title="注册客户中心" subtitle="仅限邀请注册，需使用管理员签发的邀请码。" wide>
      <AuthNotice tone="neutral">
        当前仅开放邀请注册：可使用管理员签发、绑定指定邮箱的一次性邀请码，或已注册用户分享的个人邀请码。个人邀请码只用于注册，不能登录任何账户。
      </AuthNotice>
      {referralSourceCode !== null && (
        <AuthNotice tone="neutral">
          已携带推荐来源。注册完成后仅保存为待确认的来源候选，不代表正式推荐归属或佣金资格。
        </AuthNotice>
      )}
      {notice && <AuthNotice tone={notice.tone} id={noticeId}>{notice.text}</AuthNotice>}

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
              disabled={busy || identityLocked}
              aria-describedby={notice ? noticeId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor={codeId}>邮箱验证码</label>
          <div className="auth-code-row">
            <div className="auth-input-wrap">
              <input
                id={codeId}
                name="verificationCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="请输入邮件中的验证码"
                value={verificationCode}
                maxLength={6}
                disabled={busy || phase !== "awaiting_verification"}
                onChange={(event) => setVerificationCode(event.target.value)}
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
                ? "正在发送…"
                : countdown > 0
                  ? `${countdown} 秒后重发`
                  : phase === "not_started"
                    ? "发送验证码"
                    : "重新发送验证码"}
            </button>
          </div>
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>密码</label>
          <div className="auth-input-wrap">
            <input
              id={passwordId}
              name="password"
              type={revealPassword ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="请设置密码"
              value={password}
              disabled={busy || completed}
              aria-describedby={passwordHintId}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={revealPassword}
              aria-controls={passwordId}
              disabled={busy || completed}
              onClick={() => setRevealPassword((current) => !current)}
            >
              <RevealIcon revealed={revealPassword} />
            </button>
          </div>
          <p className="auth-hint" id={passwordHintId}>
            至少 {REGISTRATION_PASSWORD_MIN_LENGTH} 个字符，最终以服务端校验为准。
          </p>
        </div>

        <div className="auth-field">
          <label htmlFor={confirmId}>确认密码</label>
          <div className="auth-input-wrap">
            <input
              id={confirmId}
              name="confirmPassword"
              type={revealConfirm ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="请再次输入密码"
              value={confirmPassword}
              disabled={busy || completed}
              aria-invalid={confirmMismatch}
              aria-describedby={confirmMismatch ? confirmHintId : undefined}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealConfirm ? "隐藏确认密码" : "显示确认密码"}
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
            {confirmMismatch ? "两次输入的密码不一致。" : " "}
          </p>
        </div>

        <div className="auth-field">
          <label htmlFor={inviteId}>邀请码</label>
          <div className="auth-input-wrap">
            <input
              id={inviteId}
              name="inviteCode"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={34}
              placeholder="请输入邀请码"
              value={inviteCode}
              disabled={busy || identityLocked}
              onChange={(event) => setInviteCode(event.target.value)}
            />
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={busy || completed} aria-busy={status === "submitting"}>
          {completed ? "注册完成" : status === "submitting" ? "正在注册…" : "注册"}
        </button>
      </form>

      <p className="auth-switch">
        已有账号？<Link to="/login">去登录</Link>
      </p>
    </AuthShell>
  );
}

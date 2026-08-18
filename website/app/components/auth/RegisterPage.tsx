import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthNotice, AuthShell, RevealIcon } from "./AuthShell";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "./passwordPolicy";

/* WEB-AUTH-01A：仅注册页视觉与本地状态。
   本页不发送任何网络请求，不发邮件、不 mock 验证码、不创建用户 / Session，
   不写 Cookie / token / storage，不自动跳转 Dashboard。
   真实注册接线（含邀请码与验证码的服务端语义）留给后续包。 */

const DEMO_LATENCY_MS = 900;
const VERIFICATION_COUNTDOWN_SECONDS = 60;

type FormStatus = "idle" | "submitting";
type Notice = { tone: "danger" | "neutral"; text: string };

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
  const [inviteCode, setInviteCode] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);
  const [status, setStatus] = useState<FormStatus>("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [countdown, setCountdown] = useState(0);
  const submitTimerRef = useRef<number | null>(null);

  const submitting = status === "submitting";
  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  useEffect(() => {
    if (countdown <= 0) return;
    const tick = window.setTimeout(() => setCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [countdown]);

  useEffect(() => () => {
    if (submitTimerRef.current !== null) window.clearTimeout(submitTimerRef.current);
  }, []);

  function handleSendCode() {
    if (countdown > 0 || submitting) return;
    // 只做本地倒计时演示，不发请求、不发邮件、不产生任何验证码。
    setCountdown(VERIFICATION_COUNTDOWN_SECONDS);
    setNotice({ tone: "neutral", text: "验证码服务尚未接入，此处仅为界面演示。" });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 最小本地校验：只做存在性与两次密码一致性。
    // 邀请码格式、验证码规则、密码策略均由服务端裁决，本页不自行发明。
    if (!email.trim() || !verificationCode.trim() || !password || !confirmPassword || !inviteCode.trim()) {
      setNotice({ tone: "danger", text: "请填写全部字段后再提交。" });
      return;
    }
    if (password !== confirmPassword) {
      setNotice({ tone: "danger", text: "两次输入的密码不一致。" });
      return;
    }

    // 进入 loading 时不清空既有提示，避免提示区消失造成布局跳动。
    setStatus("submitting");
    if (submitTimerRef.current !== null) window.clearTimeout(submitTimerRef.current);
    submitTimerRef.current = window.setTimeout(() => {
      setStatus("idle");
      // 如实说明：注册服务尚未接线，不冒充任何服务端结果、不创建任何账号。
      setNotice({ tone: "danger", text: "注册服务尚未接入，当前页面仅供界面验收。" });
    }, DEMO_LATENCY_MS);
  }

  return (
    <AuthShell title="注册客户中心" subtitle="创建账号后进入服务管理页面。" wide>
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
              disabled={submitting}
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
                disabled={submitting}
                onChange={(event) => setVerificationCode(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="auth-code-button"
              disabled={submitting || countdown > 0}
              aria-disabled={submitting || countdown > 0}
              onClick={handleSendCode}
            >
              {countdown > 0 ? `${countdown} 秒后重发` : "发送验证码"}
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
              disabled={submitting}
              aria-describedby={passwordHintId}
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
              disabled={submitting}
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
              disabled={submitting}
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
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="请输入邀请码"
              value={inviteCode}
              disabled={submitting}
              onChange={(event) => setInviteCode(event.target.value)}
            />
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "正在注册…" : "注册"}
        </button>
      </form>

      <p className="auth-switch">
        已有账号？<Link to="/login">去登录</Link>
      </p>
    </AuthShell>
  );
}

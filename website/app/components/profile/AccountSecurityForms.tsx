import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  AccountApiError,
  changePassword,
  confirmEmailChange,
  startEmailChange,
} from "../../lib/account-api";
import { useAuth } from "../../lib/auth";
import { PASSWORD_MAX_LENGTH, REGISTRATION_PASSWORD_MIN_LENGTH } from "../auth/passwordPolicy";
import {
  emailChangeError,
  hasErrors,
  passwordChangeError,
  validateEmailChangeCode,
  validateEmailChangeStart,
  validatePasswordChange,
  type EmailChangeField,
  type FieldErrors,
  type PasswordChangeField,
} from "./accountSecurityModel";

/* 密码、验证码与改邮箱令牌只保存在组件内存中：不写 URL、路由状态或 storage。 */

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
const RESEND_COOLDOWN_SECONDS = 60;

type Notice = { tone: "danger" | "success"; text: string };

function apiErrorCode(error: unknown): string | null {
  return error instanceof AccountApiError ? error.code : null;
}

function PanelNotice({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <p className={`cc-profile-form-notice is-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"}>
      {notice.text}
    </p>
  );
}

/* 可展开 / 收起的面板：默认收起；收起时内容仅隐藏，已填内容保留在组件内存中。 */
function CollapsiblePanel(props: { eyebrow: string; title: string; children: ReactNode }) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className={`cc-profile-panel cc-profile-collapsible${open ? " is-open" : ""}`} aria-labelledby={`${baseId}-title`}>
      <h2 className="cc-profile-toggle-heading" id={`${baseId}-title`}>
        <button
          type="button"
          className="cc-profile-toggle"
          aria-expanded={open}
          aria-controls={`${baseId}-content`}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="cc-profile-toggle-text">
            <em>{props.eyebrow}</em>
            <span>{props.title}</span>
          </span>
          <svg className="cc-profile-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h2>
      <div className="cc-profile-collapsible-body" id={`${baseId}-content`} hidden={!open}>
        {props.children}
      </div>
    </section>
  );
}

function Field(props: {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const errorId = `${props.id}-error`;
  const hintId = `${props.id}-hint`;
  const describedBy = [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="cc-profile-field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children(describedBy)}
      {props.hint && <p className="cc-profile-hint" id={hintId}>{props.hint}</p>}
      {props.error && <p className="cc-profile-hint is-danger" id={errorId} aria-live="polite">{props.error}</p>}
    </div>
  );
}

export function PasswordChangePanel() {
  const { csrfToken } = useAuth();
  const baseId = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<PasswordChangeField>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  function edit(field: PasswordChangeField, setter: (value: string) => void, value: string) {
    setter(value);
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const local = validatePasswordChange({ currentPassword, newPassword, confirmPassword }, POLICY);
    setErrors(local);
    setNotice(null);
    if (hasErrors(local)) return;
    if (csrfToken === null) {
      setNotice({ tone: "danger", text: "登录状态已失效，请重新登录。" });
      return;
    }
    setBusy(true);
    try {
      await changePassword(csrfToken, { currentPassword, newPassword, confirmPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice({ tone: "success", text: "密码已修改。其他设备上的登录已退出，当前设备保持登录。" });
    } catch (error) {
      const mapped = passwordChangeError(apiErrorCode(error));
      if (mapped.field) setErrors({ [mapped.field]: mapped.text });
      else setNotice({ tone: "danger", text: mapped.text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <CollapsiblePanel eyebrow="SECURITY" title="修改密码">
      <PanelNotice notice={notice} />
      <form className="cc-profile-form" onSubmit={handleSubmit} noValidate>
        <Field id={`${baseId}-current`} label="当前密码" error={errors.currentPassword}>
          {(describedBy) => (
            <input id={`${baseId}-current`} name="currentPassword" type="password" autoComplete="current-password" maxLength={PASSWORD_MAX_LENGTH} value={currentPassword} disabled={busy} aria-invalid={errors.currentPassword !== undefined} aria-describedby={describedBy} onChange={(event) => edit("currentPassword", setCurrentPassword, event.target.value)} />
          )}
        </Field>
        <Field id={`${baseId}-new`} label="新密码" error={errors.newPassword} hint={`${REGISTRATION_PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符，最终以服务端校验为准。`}>
          {(describedBy) => (
            <input id={`${baseId}-new`} name="newPassword" type="password" autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={newPassword} disabled={busy} aria-invalid={errors.newPassword !== undefined} aria-describedby={describedBy} onChange={(event) => { edit("newPassword", setNewPassword, event.target.value); setErrors((current) => ({ ...current, confirmPassword: undefined })); }} />
          )}
        </Field>
        <Field id={`${baseId}-confirm`} label="确认新密码" error={errors.confirmPassword}>
          {(describedBy) => (
            <input id={`${baseId}-confirm`} name="confirmPassword" type="password" autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={confirmPassword} disabled={busy} aria-invalid={errors.confirmPassword !== undefined} aria-describedby={describedBy} onChange={(event) => edit("confirmPassword", setConfirmPassword, event.target.value)} />
          )}
        </Field>
        <div className="cc-profile-actions">
          <button type="submit" className="cc-profile-primary" disabled={busy} aria-busy={busy}>{busy ? "正在修改…" : "修改密码"}</button>
        </div>
      </form>
    </CollapsiblePanel>
  );
}

export function EmailChangePanel({ currentEmail }: { currentEmail: string }) {
  const { csrfToken, refresh } = useAuth();
  const baseId = useId();
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [changeToken, setChangeToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors<EmailChangeField>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const awaitingCode = changeToken !== null;

  useEffect(() => {
    if (countdown <= 0) return;
    const tick = window.setTimeout(() => setCountdown((current) => current - 1), 1000);
    return () => window.clearTimeout(tick);
  }, [countdown]);

  function edit(field: EmailChangeField, setter: (value: string) => void, value: string) {
    setter(value);
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function showError(error: unknown) {
    const mapped = emailChangeError(apiErrorCode(error));
    if (mapped.field) setErrors({ [mapped.field]: mapped.text });
    else setNotice({ tone: "danger", text: mapped.text });
  }

  async function sendCode() {
    if (busy || countdown > 0) return;
    const local = validateEmailChangeStart({ currentPassword, newEmail, currentEmail });
    setErrors(local);
    setNotice(null);
    if (hasErrors(local)) return;
    if (csrfToken === null) {
      setNotice({ tone: "danger", text: "登录状态已失效，请重新登录。" });
      return;
    }
    setBusy(true);
    try {
      const started = await startEmailChange(csrfToken, { currentPassword, newEmail: newEmail.trim() });
      setChangeToken(started.changeToken);
      setCode("");
      setCountdown(RESEND_COOLDOWN_SECONDS);
      setNotice({ tone: "success", text: "验证码已发送到新邮箱，10 分钟内有效。" });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setChangeToken(null);
    setCode("");
    setCountdown(0);
    setErrors({});
    setNotice(null);
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!awaitingCode) {
      await sendCode();
      return;
    }
    const local = validateEmailChangeCode(code);
    setErrors(local);
    setNotice(null);
    if (hasErrors(local)) return;
    if (csrfToken === null) {
      setNotice({ tone: "danger", text: "登录状态已失效，请重新登录。" });
      return;
    }
    setBusy(true);
    try {
      await confirmEmailChange(csrfToken, { changeToken, code: code.trim() });
      const changedTo = newEmail.trim().toLowerCase();
      setChangeToken(null);
      setCode("");
      setCurrentPassword("");
      setNewEmail("");
      setCountdown(0);
      setNotice({ tone: "success", text: `登录邮箱已修改为 ${changedTo}。其他设备上的登录已退出，原邮箱会收到变更通知。` });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CollapsiblePanel eyebrow="LOGIN EMAIL" title="修改邮箱">
      <PanelNotice notice={notice} />
      <form className="cc-profile-form" onSubmit={handleConfirm} noValidate>
        <Field id={`${baseId}-email`} label="新邮箱" error={errors.newEmail}>
          {(describedBy) => (
            <input id={`${baseId}-email`} name="newEmail" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={newEmail} disabled={busy || awaitingCode} aria-invalid={errors.newEmail !== undefined} aria-describedby={describedBy} onChange={(event) => edit("newEmail", setNewEmail, event.target.value)} />
          )}
        </Field>
        <Field id={`${baseId}-password`} label="当前密码" error={errors.currentPassword}>
          {(describedBy) => (
            <input id={`${baseId}-password`} name="currentPassword" type="password" autoComplete="current-password" maxLength={PASSWORD_MAX_LENGTH} value={currentPassword} disabled={busy || awaitingCode} aria-invalid={errors.currentPassword !== undefined} aria-describedby={describedBy} onChange={(event) => edit("currentPassword", setCurrentPassword, event.target.value)} />
          )}
        </Field>
        {awaitingCode && (
          <Field id={`${baseId}-code`} label="新邮箱验证码" error={errors.code}>
            {(describedBy) => (
              <div className="cc-profile-code-row">
                <input id={`${baseId}-code`} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} maxLength={6} value={code} disabled={busy} aria-invalid={errors.code !== undefined} aria-describedby={describedBy} onChange={(event) => edit("code", setCode, event.target.value)} />
                <button type="button" className="cc-profile-secondary" disabled={busy || countdown > 0} onClick={() => void sendCode()}>
                  {countdown > 0 ? `${countdown} 秒后重发` : "重新发送"}
                </button>
              </div>
            )}
          </Field>
        )}
        <div className="cc-profile-actions">
          <button type="submit" className="cc-profile-primary" disabled={busy} aria-busy={busy}>
            {busy ? "请稍候…" : awaitingCode ? "确认修改" : "发送验证码"}
          </button>
          {awaitingCode && <button type="button" className="cc-profile-secondary" disabled={busy} onClick={reset}>更换新邮箱</button>}
        </div>
      </form>
    </CollapsiblePanel>
  );
}

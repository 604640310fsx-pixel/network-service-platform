import type { Messages } from "../../i18n/zh";

/* 个人中心「修改密码 / 修改邮箱」的本地校验与错误文案（纯逻辑，便于测试）。
   本地只检查格式与既有冻结策略（密码 12–256 位、验证码 6 位数字），
   其余以服务端返回为准；错误文案只按服务端明确的错误码给出。
   文案由调用方按当前界面语言传入（Messages["security"]）。 */

type SecurityMessages = Messages["security"];

export type PasswordPolicy = { minLength: number; maxLength: number };

export type PasswordChangeField = "currentPassword" | "newPassword" | "confirmPassword";
export type EmailChangeField = "currentPassword" | "newEmail" | "code";
export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

const CODE_PATTERN = /^[0-9]{6}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hasErrors(errors: Readonly<Record<string, string | undefined>>): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}

export function validatePasswordChange(
  input: { currentPassword: string; newPassword: string; confirmPassword: string },
  policy: PasswordPolicy,
  messages: SecurityMessages["validation"],
): FieldErrors<PasswordChangeField> {
  const errors: FieldErrors<PasswordChangeField> = {};
  if (input.currentPassword === "") errors.currentPassword = messages.currentRequired;
  if (input.newPassword === "") {
    errors.newPassword = messages.newRequired;
  } else if (input.newPassword.length < policy.minLength) {
    errors.newPassword = messages.newMin(policy.minLength);
  } else if (input.newPassword.length > policy.maxLength) {
    errors.newPassword = messages.newMax(policy.maxLength);
  }
  if (input.confirmPassword === "") {
    errors.confirmPassword = messages.confirmRequired;
  } else if (input.newPassword !== input.confirmPassword) {
    errors.confirmPassword = messages.confirmMismatch;
  }
  return errors;
}

export function validateEmailChangeStart(
  input: { currentPassword: string; newEmail: string; currentEmail: string },
  messages: SecurityMessages["validation"],
): FieldErrors<EmailChangeField> {
  const errors: FieldErrors<EmailChangeField> = {};
  const newEmail = input.newEmail.trim();
  if (newEmail === "") {
    errors.newEmail = messages.emailRequired;
  } else if (!EMAIL_SHAPE.test(newEmail)) {
    errors.newEmail = messages.emailInvalid;
  } else if (newEmail.toLowerCase() === input.currentEmail.toLowerCase()) {
    errors.newEmail = messages.emailSame;
  }
  if (input.currentPassword === "") errors.currentPassword = messages.currentRequired;
  return errors;
}

export function validateEmailChangeCode(code: string, messages: SecurityMessages["validation"]): FieldErrors<EmailChangeField> {
  const trimmed = code.trim();
  if (trimmed === "") return { code: messages.codeRequired };
  if (!CODE_PATTERN.test(trimmed)) return { code: messages.codeFormat };
  return {};
}

export type AccountErrorNotice<Field extends string> = { field?: Field; text: string };

function commonError(code: string | null, messages: SecurityMessages["errors"]): string {
  switch (code) {
    case "rate_limited":
      return messages.rateLimited;
    case "unauthorized":
      return messages.unauthorized;
    case "csrf_invalid":
      return messages.csrfInvalid;
    default:
      return messages.generic;
  }
}

/** code 为 null 表示网络或非 API 错误。 */
export function passwordChangeError(code: string | null, messages: SecurityMessages["errors"]): AccountErrorNotice<PasswordChangeField> {
  switch (code) {
    case "invalid_credentials":
      return { field: "currentPassword", text: messages.wrongPassword };
    case "password_policy_violation":
      return { field: "newPassword", text: messages.passwordPolicy };
    default:
      return { text: commonError(code, messages) };
  }
}

export function emailChangeError(code: string | null, messages: SecurityMessages["errors"]): AccountErrorNotice<EmailChangeField> {
  switch (code) {
    case "invalid_credentials":
      return { field: "currentPassword", text: messages.wrongPassword };
    case "invalid_email":
      return { field: "newEmail", text: messages.emailInvalid };
    case "email_unchanged":
      return { field: "newEmail", text: messages.emailUnchanged };
    case "email_taken":
      return { field: "newEmail", text: messages.emailTaken };
    case "invalid_code":
      return { field: "code", text: messages.codeInvalid };
    case "invalid_or_expired":
      return { text: messages.codeExpired };
    default:
      return { text: commonError(code, messages) };
  }
}

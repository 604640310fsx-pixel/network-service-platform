/* 个人中心「修改密码 / 修改邮箱」的本地校验与错误文案（纯逻辑，便于测试）。
   本地只检查格式与既有冻结策略（密码 12–256 位、验证码 6 位数字），
   其余以服务端返回为准；错误文案只按服务端明确的错误码给出。 */

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
): FieldErrors<PasswordChangeField> {
  const errors: FieldErrors<PasswordChangeField> = {};
  if (input.currentPassword === "") errors.currentPassword = "请输入当前密码。";
  if (input.newPassword === "") {
    errors.newPassword = "请设置新密码。";
  } else if (input.newPassword.length < policy.minLength) {
    errors.newPassword = `新密码至少需要 ${policy.minLength} 个字符。`;
  } else if (input.newPassword.length > policy.maxLength) {
    errors.newPassword = `新密码不能超过 ${policy.maxLength} 个字符。`;
  }
  if (input.confirmPassword === "") {
    errors.confirmPassword = "请再次输入新密码。";
  } else if (input.newPassword !== input.confirmPassword) {
    errors.confirmPassword = "两次输入的新密码不一致。";
  }
  return errors;
}

export function validateEmailChangeStart(
  input: { currentPassword: string; newEmail: string; currentEmail: string },
): FieldErrors<EmailChangeField> {
  const errors: FieldErrors<EmailChangeField> = {};
  const newEmail = input.newEmail.trim();
  if (newEmail === "") {
    errors.newEmail = "请输入新邮箱。";
  } else if (!EMAIL_SHAPE.test(newEmail)) {
    errors.newEmail = "请输入有效的邮箱地址。";
  } else if (newEmail.toLowerCase() === input.currentEmail.toLowerCase()) {
    errors.newEmail = "新邮箱与当前邮箱相同。";
  }
  if (input.currentPassword === "") errors.currentPassword = "请输入当前密码。";
  return errors;
}

export function validateEmailChangeCode(code: string): FieldErrors<EmailChangeField> {
  const trimmed = code.trim();
  if (trimmed === "") return { code: "请输入邮箱验证码。" };
  if (!CODE_PATTERN.test(trimmed)) return { code: "验证码应为 6 位数字。" };
  return {};
}

export type AccountErrorNotice<Field extends string> = { field?: Field; text: string };

function commonError(code: string | null): string {
  switch (code) {
    case "rate_limited":
      return "操作过于频繁，请稍后再试。";
    case "unauthorized":
      return "登录状态已失效，请重新登录。";
    case "csrf_invalid":
      return "登录状态已变化，请刷新页面后重试。";
    default:
      return "暂时无法完成操作，请稍后重试。";
  }
}

/** code 为 null 表示网络或非 API 错误。 */
export function passwordChangeError(code: string | null): AccountErrorNotice<PasswordChangeField> {
  switch (code) {
    case "invalid_credentials":
      return { field: "currentPassword", text: "当前密码不正确。" };
    case "password_policy_violation":
      return { field: "newPassword", text: "新密码不符合要求，请使用 12–256 个字符。" };
    default:
      return { text: commonError(code) };
  }
}

export function emailChangeError(code: string | null): AccountErrorNotice<EmailChangeField> {
  switch (code) {
    case "invalid_credentials":
      return { field: "currentPassword", text: "当前密码不正确。" };
    case "invalid_email":
      return { field: "newEmail", text: "请输入有效的邮箱地址。" };
    case "email_unchanged":
      return { field: "newEmail", text: "新邮箱与当前邮箱相同。" };
    case "email_taken":
      return { field: "newEmail", text: "该邮箱已被其他账户使用。" };
    case "invalid_code":
      return { field: "code", text: "验证码不正确，请检查后重试。" };
    case "invalid_or_expired":
      return { text: "验证码已过期或申请已失效，请重新发送验证码。" };
    default:
      return { text: commonError(code) };
  }
}

/* 忘记密码 / 重置密码的纯校验与错误文案（纯逻辑，便于测试）；
   密码长度策略由调用方传入既有冻结常量，页面组件只负责状态与渲染。 */

export type PasswordPolicy = { minLength: number; maxLength: number };

export const RESET_REQUEST_SENT_NOTICE = "如果该邮箱已注册，我们已发送重置链接，请查收邮件";
export const RESET_DONE_NOTICE = "密码已重置，请使用新密码登录";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateResetEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return "请输入邮箱。";
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) return "请输入有效的邮箱地址。";
  return null;
}

export interface ResetPasswordErrors {
  password?: string;
  confirmPassword?: string;
}

export function validateResetPassword(password: string, confirmPassword: string, policy: PasswordPolicy): ResetPasswordErrors {
  const errors: ResetPasswordErrors = {};
  if (!password) errors.password = "请设置新密码。";
  else if (password.length < policy.minLength) {
    errors.password = `新密码至少需要 ${policy.minLength} 个字符。`;
  } else if (password.length > policy.maxLength) {
    errors.password = `新密码不能超过 ${policy.maxLength} 个字符。`;
  }
  if (!confirmPassword) errors.confirmPassword = "请再次输入新密码。";
  else if (password !== confirmPassword) errors.confirmPassword = "两次输入的新密码不一致。";
  return errors;
}

export function resetRequestErrorMessage(code: string): string {
  switch (code) {
    case "rate_limited":
      return "请求过于频繁，请稍后再试。";
    case "network_error":
      return "网络连接失败，请检查网络后重试。";
    default:
      return "暂时无法发送重置邮件，请稍后重试。";
  }
}

export type ResetConfirmFailure =
  | { readonly kind: "invalid_token" }
  | { readonly kind: "field"; readonly text: string }
  | { readonly kind: "form"; readonly text: string };

export function resetConfirmFailure(code: string, policy: PasswordPolicy): ResetConfirmFailure {
  switch (code) {
    case "invalid_token":
      return { kind: "invalid_token" };
    case "password_policy_violation":
      return { kind: "field", text: `新密码需为 ${policy.minLength}–${policy.maxLength} 个字符。` };
    case "rate_limited":
      return { kind: "form", text: "尝试次数过多，请稍后再试。" };
    case "busy":
      return { kind: "form", text: "服务繁忙，请稍后重试。" };
    case "network_error":
      return { kind: "form", text: "网络连接失败，请检查网络后重试。" };
    default:
      return { kind: "form", text: "暂时无法重置密码，请稍后重试。" };
  }
}

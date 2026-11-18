import type { Messages } from "../../i18n/zh";

/* 忘记密码 / 重置密码的纯校验与错误文案选择（纯逻辑，便于测试）；
   密码长度策略与文案都由调用方传入（既有冻结常量与当前界面语言的 Messages）。 */

export type PasswordPolicy = { minLength: number; maxLength: number };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateResetEmail(email: string, messages: Messages["forgot"]["validation"]): string | null {
  const trimmed = email.trim();
  if (!trimmed) return messages.emailRequired;
  if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) return messages.emailInvalid;
  return null;
}

export interface ResetPasswordErrors {
  password?: string;
  confirmPassword?: string;
}

export function validateResetPassword(
  password: string,
  confirmPassword: string,
  policy: PasswordPolicy,
  messages: Messages["reset"]["validation"],
): ResetPasswordErrors {
  const errors: ResetPasswordErrors = {};
  if (!password) errors.password = messages.passwordRequired;
  else if (password.length < policy.minLength) errors.password = messages.passwordMin(policy.minLength);
  else if (password.length > policy.maxLength) errors.password = messages.passwordMax(policy.maxLength);
  if (!confirmPassword) errors.confirmPassword = messages.confirmRequired;
  else if (password !== confirmPassword) errors.confirmPassword = messages.confirmMismatch;
  return errors;
}

export function resetRequestErrorMessage(code: string, messages: Messages["forgot"]["errors"]): string {
  switch (code) {
    case "rate_limited":
      return messages.rateLimited;
    case "network_error":
      return messages.network;
    default:
      return messages.generic;
  }
}

export type ResetConfirmFailure =
  | { readonly kind: "invalid_token" }
  | { readonly kind: "field"; readonly text: string }
  | { readonly kind: "form"; readonly text: string };

export function resetConfirmFailure(
  code: string,
  policy: PasswordPolicy,
  messages: Messages["reset"]["errors"],
): ResetConfirmFailure {
  switch (code) {
    case "invalid_token":
      return { kind: "invalid_token" };
    case "password_policy_violation":
      return { kind: "field", text: messages.passwordPolicy(policy.minLength, policy.maxLength) };
    case "rate_limited":
      return { kind: "form", text: messages.rateLimited };
    case "busy":
      return { kind: "form", text: messages.busy };
    case "network_error":
      return { kind: "form", text: messages.network };
    default:
      return { kind: "form", text: messages.generic };
  }
}

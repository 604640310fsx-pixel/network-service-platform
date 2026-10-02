import type { Messages } from "../../i18n/zh";

/* 注册表单的本地校验与提交流程（纯逻辑，无 DOM / 网络依赖，便于测试）。
   本地校验只做格式与既有冻结策略检查（验证码 6 位数字、密码 12–256 位、
   两次一致），不猜测账号或邀请码状态；服务端错误仍由页面按通用文案展示。
   文案由调用方按当前界面语言传入（Messages["register"] 的对应分组）。 */

export type RegistrationPhase =
  | "not_started"
  | "awaiting_verification"
  | "verified"
  | "completed";

export type RegistrationFieldErrors = {
  verificationCode?: string;
  password?: string;
  confirmPassword?: string;
};

export type PasswordPolicy = { minLength: number; maxLength: number };

// 与 auth-service REGISTRATION_OTP_PATTERN 一致。
const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/;

export function validateRegistrationSubmission(
  input: {
    phase: RegistrationPhase;
    verificationCode: string;
    password: string;
    confirmPassword: string;
  },
  policy: PasswordPolicy,
  messages: Messages["register"]["validation"],
): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};
  if (input.phase === "awaiting_verification") {
    const code = input.verificationCode.trim();
    if (code === "") {
      errors.verificationCode = messages.codeRequired;
    } else if (!VERIFICATION_CODE_PATTERN.test(code)) {
      errors.verificationCode = messages.codeFormat;
    }
  }
  if (input.password === "") {
    errors.password = messages.passwordRequired;
  } else if (input.password.length < policy.minLength) {
    errors.password = messages.passwordMin(policy.minLength);
  } else if (input.password.length > policy.maxLength) {
    errors.password = messages.passwordMax(policy.maxLength);
  }
  if (input.confirmPassword === "") {
    errors.confirmPassword = messages.confirmRequired;
  } else if (input.password !== input.confirmPassword) {
    errors.confirmPassword = messages.confirmMismatch;
  }
  return errors;
}

export type RegistrationErrorNotice = { text: string; loginLink: boolean };

/* 服务端错误码到文案。只有服务端明确返回 email_taken（完成步骤、邮箱已通过
   验证码确认后才会出现）时才提示“已注册”；其余错误一律保持通用文案，
   不从 invalid_request / invalid_or_expired 等推测账号或邀请码状态。
   code 为 null 表示网络或非 API 错误。 */
export function registrationErrorNotice(
  code: string | null,
  messages: Messages["register"]["errors"],
): RegistrationErrorNotice {
  switch (code) {
    case null:
      return { text: messages.unavailable, loginLink: false };
    case "email_taken":
      return { text: messages.emailTaken, loginLink: true };
    case "rate_limited":
      return { text: messages.rateLimited, loginLink: false };
    case "password_policy_violation":
      return { text: messages.passwordPolicy, loginLink: false };
    case "invalid_or_expired":
      return { text: messages.invalidOrExpired, loginLink: false };
    case "invalid_request":
      return { text: messages.invalidRequest, loginLink: false };
    default:
      return { text: messages.generic, loginLink: false };
  }
}

export function hasFieldErrors(errors: RegistrationFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export type RegistrationRequests = {
  verify: (registrationToken: string, otp: string) => Promise<string>;
  complete: (
    registrationToken: string,
    password: string,
    confirmPassword: string,
  ) => Promise<void>;
};

export type RegistrationSubmissionResult =
  | { kind: "completed" }
  | {
      kind: "failed";
      error: unknown;
      // 失败后应保留的服务端状态：验证码已验证成功时，下一次只重试完成步骤。
      phase: "awaiting_verification" | "verified";
      registrationToken: string;
    };

export async function runRegistrationSubmission(
  state: {
    phase: "awaiting_verification" | "verified";
    registrationToken: string;
    verificationCode: string;
    password: string;
    confirmPassword: string;
  },
  requests: RegistrationRequests,
): Promise<RegistrationSubmissionResult> {
  let phase = state.phase;
  let registrationToken = state.registrationToken;
  try {
    if (phase === "awaiting_verification") {
      registrationToken = await requests.verify(
        registrationToken,
        state.verificationCode.trim(),
      );
      phase = "verified";
    }
    await requests.complete(
      registrationToken,
      state.password,
      state.confirmPassword,
    );
    return { kind: "completed" };
  } catch (error) {
    return { kind: "failed", error, phase, registrationToken };
  }
}

/* 注册成功后跳转登录页：替换历史记录，只携带一个非敏感布尔标记，
   不经 URL、路由状态或 storage 传递密码、验证码、邀请码或 token。 */
export const REGISTRATION_SUCCESS_NAVIGATION = Object.freeze({
  to: "/login",
  options: Object.freeze({
    replace: true,
    state: Object.freeze({ registrationComplete: true }),
  }),
});

export function registrationCompleteFromLocationState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    !Array.isArray(state) &&
    Object.keys(state).length === 1 &&
    (state as { registrationComplete?: unknown }).registrationComplete === true
  );
}

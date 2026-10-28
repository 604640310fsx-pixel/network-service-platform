import type { Messages } from "../../i18n/zh";

/* 注册表单的本地校验与提交流程（纯逻辑，无 DOM / 网络依赖，便于测试）。
   本地校验只做格式与既有冻结策略检查（邮箱与邀请码格式镜像服务端 schema、
   验证码 6 位数字、密码 12–256 位、两次一致），不猜测账号或邀请码状态；
   服务端错误按实际请求阶段映射为文案，不推断账号或邀请码是否存在。
   文案由调用方按当前界面语言传入（Messages["register"] 的对应分组）。 */

export type RegistrationPhase =
  | "not_started"
  | "awaiting_verification"
  | "verified"
  | "completed";

export type RegistrationFieldErrors = {
  email?: string;
  inviteCode?: string;
  verificationCode?: string;
  password?: string;
  confirmPassword?: string;
};

export type PasswordPolicy = { minLength: number; maxLength: number };

// 与 auth-service REGISTRATION_OTP_PATTERN 一致。
const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/;

// 与 auth-service email.ts 的 EMAIL_PATTERN 一致（服务端先转小写再匹配）。
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_MAX_LENGTH = 254;
// 与 auth-service 注册 start 路由的 inviteCode schema 一致：个人 24 位（区分大小写），
// 或旧版管理员邀请码（invite-code.ts INVITE_CODE_PATTERN）。纯逻辑模块不跨文件取值，
// 改动须与服务端同步；提交时的规范化仍由 registration-api canonicalInviteCode 完成。
const PERSONAL_INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const LEGACY_INVITE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
// 只看分组结构、不限字符集，用于识别“像管理员邀请码但含 I/L/O/U 等字符”的输入。
const LEGACY_INVITE_SHAPE = /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){6}$/;

function emailError(
  value: string,
  messages: Messages["register"]["validation"],
): string | undefined {
  const email = value.trim();
  if (email === "") return messages.emailRequired;
  // 服务端只接受可见 ASCII：中文、全角符号、空格和不可见字符都会被拒绝。
  if (/[^\x21-\x7e]/.test(email)) return messages.emailCharacters;
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email.toLowerCase())) {
    return messages.emailFormat;
  }
  return undefined;
}

/* 只检查格式（个人 24 位区分大小写，或旧版管理员 7×4 分组），不判断邀请码
   是否存在或可用；不从粘贴的链接中自动提取，也不补字符或改写个人邀请码。 */
function inviteCodeError(
  value: string,
  messages: Messages["register"]["validation"],
): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return messages.inviteRequired;
  // 个人邀请码按原样匹配；旧版管理员邀请码在提交时转大写，这里同样按大写匹配。
  if (
    PERSONAL_INVITE_CODE_PATTERN.test(trimmed) ||
    LEGACY_INVITE_CODE_PATTERN.test(trimmed.toUpperCase())
  ) {
    return undefined;
  }
  if (/[/?=:]/.test(trimmed)) return messages.inviteLink;
  if (/[^A-Za-z0-9_-]/.test(trimmed)) return messages.inviteCharacters;
  if (LEGACY_INVITE_SHAPE.test(trimmed)) return messages.inviteLegacyCharacters;
  return messages.inviteLength(trimmed.length);
}

/* 发送验证码前只校验邮箱和邀请码；不要求验证码或密码。 */
export function validateRegistrationStart(
  input: { email: string; inviteCode: string },
  messages: Messages["register"]["validation"],
): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};
  const email = emailError(input.email, messages);
  if (email !== undefined) errors.email = email;
  const inviteCode = inviteCodeError(input.inviteCode, messages);
  if (inviteCode !== undefined) errors.inviteCode = inviteCode;
  return errors;
}

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

/* 发出请求的阶段：start / resend 发送验证码，verify 校验验证码，complete 完成注册。 */
export type RegistrationStage = "start" | "resend" | "verify" | "complete";

/* recovery：
   - none：保留当前状态，用户可修正后重试；
   - restart：提供“重新开始”入口（验证码错误与过期在服务端是同一个错误码，
     token 可能仍有效，不自动丢弃）；
   - reset：该 token 已确定不可用，页面回到发送验证码前的状态并保留已填内容。 */
export type RegistrationErrorNotice = {
  text: string;
  loginLink: boolean;
  recovery: "none" | "restart" | "reset";
};

/* 服务端错误码到文案，按实际请求阶段区分。只有完成步骤明确返回 email_taken
   （邮箱已通过验证码确认后才会出现）时才提示“已注册”；invalid_or_expired 是
   “错误或已失效”的合并错误码，文案保持合并表述；invalid_request 在本地格式
   校验通过后出现时只说明请求未被接受，不推测邀请码或账号状态。
   code 为 null 表示非 API 的未知错误；不展示服务端原文。 */
export function registrationErrorNotice(
  code: string | null,
  stage: RegistrationStage,
  messages: Messages["register"]["errors"],
): RegistrationErrorNotice {
  const notice = (
    text: string,
    recovery: RegistrationErrorNotice["recovery"] = "none",
  ): RegistrationErrorNotice => ({ text, loginLink: false, recovery });
  switch (code) {
    case "network_error":
      return notice(messages.network);
    case "auth_unavailable":
      return notice(messages.unavailable);
    case "busy":
      return notice(messages.busy);
    case "rate_limited":
      return notice(
        stage === "start" || stage === "resend"
          ? messages.rateLimitedSend
          : messages.rateLimited,
      );
    case "origin_rejected":
      return notice(messages.originRejected);
    case "invalid_request":
      return notice(messages.invalidRequest);
    case "invalid_or_expired":
      if (stage === "verify") return notice(messages.codeInvalidOrExpired, "restart");
      return notice(messages.sessionExpired, "reset");
    case "email_taken":
      return stage === "complete"
        ? { text: messages.emailTaken, loginLink: true, recovery: "none" }
        : notice(messages.generic);
    case "password_policy_violation":
      return notice(stage === "complete" ? messages.passwordPolicy : messages.generic);
    default:
      return notice(messages.generic);
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

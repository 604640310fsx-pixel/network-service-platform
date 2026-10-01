import { canonicalizeEmail } from "../auth/email.js";
import type {
  MailDelivery,
  MailTransport,
} from "./mail-dispatcher.js";
import { PASSWORD_RESET_TOKEN_PATTERN } from "./mail-outbox.js";
import { REGISTRATION_OTP_PATTERN } from "./registration-crypto.js";

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const RESEND_IDEMPOTENCY_KEY_MAX_LENGTH = 256;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ResendMailTransportConfig {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly requestTimeoutMs: number;
  readonly dispatcherLeaseMs: number;
}

export class ResendMailTransportError extends Error {
  readonly code = "mail_delivery_failed";

  constructor() {
    super("Mail delivery failed");
    this.name = "ResendMailTransportError";
  }
}

function invalidConfiguration(): Error {
  return new Error("Resend mail transport configuration is invalid");
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidConfiguration();
  }
  return value;
}

function requireApiKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    throw invalidConfiguration();
  }
  return value;
}

function requireFromEmail(value: string): string {
  try {
    return canonicalizeEmail(value);
  } catch {
    throw invalidConfiguration();
  }
}

function requireIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > RESEND_IDEMPOTENCY_KEY_MAX_LENGTH ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    throw new ResendMailTransportError();
  }
  return value;
}

interface MailContent {
  readonly subject: string;
  readonly text: string;
}

function registrationCodeContent(code: string): MailContent {
  return {
    subject: "Network Service Platform 验证码",
    text:
      `您的邮箱验证码是：${code}\n\n` +
      "此验证码仅用于验证您对该邮箱的访问。收到并验证验证码不代表邀请码仍然有效，也不代表注册一定成功。请勿转发。",
  };
}

function emailChangeCodeContent(code: string): MailContent {
  return {
    subject: "Network Service Platform 邮箱变更验证码",
    text:
      `您正在将 Network Service Platform 账户的登录邮箱更改为此邮箱，验证码是：${code}\n\n` +
      "验证码 10 分钟内有效。如非本人操作，请忽略本邮件，账户不会发生任何变化。请勿转发。",
  };
}

// Sent to the previous address; it names no code and not the new address.
const EMAIL_CHANGED_NOTICE_CONTENT: MailContent = {
  subject: "Network Service Platform 登录邮箱已变更",
  text:
    "您的 Network Service Platform 账户登录邮箱已更改为其他地址，此邮箱今后不能再用于登录该账户。\n\n" +
    "如果这不是您本人的操作，请立即联系客服处理。本邮件无需回复。",
};

export const PASSWORD_RESET_LINK_BASE = "https://www.siqiapparel.com/reset-password?token=";

function passwordResetContent(token: string): MailContent {
  return {
    subject: "Network Service Platform 重置密码",
    text:
      "我们收到了重置您 Network Service Platform 账户密码的请求。请在 30 分钟内打开以下链接设置新密码：\n\n" +
      `${PASSWORD_RESET_LINK_BASE}${token}\n\n` +
      "链接仅可使用一次。重置成功后，该账户所有设备上的登录都会失效。\n\n" +
      "如非本人操作，请忽略本邮件，您的密码不会发生任何变化。请勿转发。",
  };
}

function requireDelivery(delivery: MailDelivery): {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly content: MailContent;
} {
  if (typeof delivery !== "object" || delivery === null) {
    throw new ResendMailTransportError();
  }
  let content: MailContent;
  if (delivery.template === "verification_code") {
    if (
      typeof delivery.verificationCode !== "string" ||
      !REGISTRATION_OTP_PATTERN.test(delivery.verificationCode)
    ) {
      throw new ResendMailTransportError();
    }
    content = delivery.idempotencyKey.startsWith("email-change-otp-v1:")
      ? emailChangeCodeContent(delivery.verificationCode)
      : registrationCodeContent(delivery.verificationCode);
  } else if (
    delivery.template === "email_changed_notice" &&
    delivery.verificationCode === null
  ) {
    content = EMAIL_CHANGED_NOTICE_CONTENT;
  } else if (
    delivery.template === "password_reset" &&
    delivery.verificationCode === null &&
    typeof delivery.resetToken === "string" &&
    PASSWORD_RESET_TOKEN_PATTERN.test(delivery.resetToken)
  ) {
    content = passwordResetContent(delivery.resetToken);
  } else {
    throw new ResendMailTransportError();
  }

  let toEmail: string;
  try {
    toEmail = canonicalizeEmail(delivery.toEmail);
  } catch {
    throw new ResendMailTransportError();
  }

  return {
    idempotencyKey: requireIdempotencyKey(delivery.idempotencyKey),
    toEmail,
    content,
  };
}

function hasOpaqueEmailId(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length <= RESEND_IDEMPOTENCY_KEY_MAX_LENGTH &&
    VISIBLE_ASCII_PATTERN.test(value.id)
  );
}

export class ResendMailTransport implements MailTransport {
  readonly #apiKey: string;
  readonly #fromEmail: string;
  readonly #requestTimeoutMs: number;
  readonly #fetchImplementation: FetchImplementation;

  constructor(
    config: ResendMailTransportConfig,
    fetchImplementation: FetchImplementation = globalThis.fetch,
  ) {
    if (typeof fetchImplementation !== "function") {
      throw invalidConfiguration();
    }
    const requestTimeoutMs = requirePositiveInteger(config.requestTimeoutMs);
    const dispatcherLeaseMs = requirePositiveInteger(config.dispatcherLeaseMs);
    if (
      requestTimeoutMs > MAX_TIMER_DELAY_MS ||
      requestTimeoutMs >= dispatcherLeaseMs
    ) {
      throw invalidConfiguration();
    }

    this.#apiKey = requireApiKey(config.apiKey);
    this.#fromEmail = requireFromEmail(config.fromEmail);
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetchImplementation = fetchImplementation;
  }

  async send(delivery: MailDelivery): Promise<void> {
    const validated = requireDelivery(delivery);
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.#requestTimeoutMs,
    );

    try {
      const response = await this.#fetchImplementation(
        RESEND_EMAILS_ENDPOINT,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": validated.idempotencyKey,
          },
          body: JSON.stringify({
            from: this.#fromEmail,
            to: [validated.toEmail],
            subject: validated.content.subject,
            text: validated.content.text,
          }),
          signal: abortController.signal,
        },
      );
      if (abortController.signal.aborted) {
        throw new ResendMailTransportError();
      }
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The provider response is intentionally discarded.
        }
        throw new ResendMailTransportError();
      }

      const providerResult: unknown = await response.json();
      if (
        abortController.signal.aborted ||
        !hasOpaqueEmailId(providerResult)
      ) {
        throw new ResendMailTransportError();
      }
    } catch {
      throw new ResendMailTransportError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

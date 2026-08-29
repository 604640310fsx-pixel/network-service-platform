import { canonicalizeEmail } from "../auth/email.js";
import type {
  MailDelivery,
  MailTransport,
} from "./mail-dispatcher.js";
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

function requireDelivery(delivery: MailDelivery): {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly verificationCode: string;
} {
  if (
    typeof delivery !== "object" ||
    delivery === null ||
    delivery.template !== "verification_code" ||
    !REGISTRATION_OTP_PATTERN.test(delivery.verificationCode)
  ) {
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
    verificationCode: delivery.verificationCode,
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
            subject: "Network Service Platform 验证码",
            text:
              `您的验证码是：${validated.verificationCode}\n\n` +
              "此验证码仅用于完成注册，请勿转发。",
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

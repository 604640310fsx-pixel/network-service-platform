import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import { REGISTRATION_OTP_PATTERN } from "./registration-crypto.js";

export const MAIL_OUTBOX_AUTH_TAG_BYTES = 16;
export const MAIL_OUTBOX_NONCE_BYTES = 12;

const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const MAIL_RECIPIENT_AUDIT_KEY_INFO = Buffer.from(
  "network-service-platform/mail-recipient-audit/v1",
  "ascii",
);

/* verification_code carries a six-digit code (registration or email change);
   email_changed_notice carries no secret and only tells the previous address
   that the account's login email was changed; password_reset carries the
   single-use reset token that the mail turns into a link. */
export type MailTemplate = "verification_code" | "email_changed_notice" | "password_reset";
export const EMAIL_CHANGED_NOTICE_PLAINTEXT = "notice";
export const PASSWORD_RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isMailTemplate(value: unknown): value is MailTemplate {
  return (
    value === "verification_code" ||
    value === "email_changed_notice" ||
    value === "password_reset"
  );
}

export interface EncryptedRegistrationOtpPayload {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly template: MailTemplate;
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface RegistrationOtpIdempotencyIdentity {
  readonly pendingRegistrationId: number;
  readonly otpGeneration: number;
}

export type MailOutboxRandomBytesSource = (size: number) => Buffer;

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Registration outbox input is invalid");
  }
}

function decodeEncryptionKey(
  keyring: TokenHmacKeyring,
  version: number,
): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    encoded === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encoded)
  ) {
    throw new Error("Registration outbox keyring is invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error("Registration outbox keyring is invalid");
  }
  return decoded;
}

export function buildRegistrationOtpIdempotencyKey(
  pendingRegistrationId: number,
  otpGeneration: number,
): string {
  assertPositiveInteger(pendingRegistrationId);
  assertPositiveInteger(otpGeneration);
  return `register-otp-v1:${pendingRegistrationId}:${otpGeneration}`;
}

export function parseRegistrationOtpIdempotencyKey(
  value: string,
): RegistrationOtpIdempotencyIdentity | null {
  const match = /^register-otp-v1:([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (match === null) {
    return null;
  }
  const pendingRegistrationId = Number(match[1]);
  const otpGeneration = Number(match[2]);
  if (
    !Number.isSafeInteger(pendingRegistrationId) ||
    !Number.isSafeInteger(otpGeneration)
  ) {
    return null;
  }
  return Object.freeze({ pendingRegistrationId, otpGeneration });
}

const NONCE_PATTERN = "[A-Za-z0-9_-]{22}";
const EMAIL_CHANGE_OTP_KEY_PATTERN = new RegExp(`^email-change-otp-v1:([1-9][0-9]*):([1-9][0-9]*):${NONCE_PATTERN}$`);
const EMAIL_CHANGED_NOTICE_KEY_PATTERN = new RegExp(`^email-changed-notice-v1:([1-9][0-9]*):([1-9][0-9]*):${NONCE_PATTERN}$`);
const PASSWORD_RESET_KEY_PATTERN = new RegExp(`^password-reset-v1:([1-9][0-9]*):([1-9][0-9]*):${NONCE_PATTERN}$`);

export interface AccountMailIdentity {
  readonly userId: number;
  readonly epochSeconds: number;
}

function buildAccountMailKey(prefix: string, userId: number, epochSeconds: number, nonce: string): string {
  assertPositiveInteger(userId);
  assertPositiveInteger(epochSeconds);
  if (!new RegExp(`^${NONCE_PATTERN}$`).test(nonce)) {
    throw new Error("Account mail nonce is invalid");
  }
  return `${prefix}:${userId}:${epochSeconds}:${nonce}`;
}

function parseAccountMailKey(pattern: RegExp, value: string): AccountMailIdentity | null {
  const match = pattern.exec(value);
  if (match === null) return null;
  const userId = Number(match[1]);
  const epochSeconds = Number(match[2]);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(epochSeconds)) return null;
  return Object.freeze({ userId, epochSeconds });
}

/** Email-change code mail; epochSeconds is the code's expiry. */
export function buildEmailChangeOtpIdempotencyKey(userId: number, expiresEpochSeconds: number, nonce: string): string {
  return buildAccountMailKey("email-change-otp-v1", userId, expiresEpochSeconds, nonce);
}

export function parseEmailChangeOtpIdempotencyKey(value: string): AccountMailIdentity | null {
  return parseAccountMailKey(EMAIL_CHANGE_OTP_KEY_PATTERN, value);
}

/** Notice to the previous address; epochSeconds is when the change happened. */
export function buildEmailChangedNoticeIdempotencyKey(userId: number, changedEpochSeconds: number, nonce: string): string {
  return buildAccountMailKey("email-changed-notice-v1", userId, changedEpochSeconds, nonce);
}

export function parseEmailChangedNoticeIdempotencyKey(value: string): AccountMailIdentity | null {
  return parseAccountMailKey(EMAIL_CHANGED_NOTICE_KEY_PATTERN, value);
}

/** Password reset link mail; epochSeconds is the token's expiry. */
export function buildPasswordResetIdempotencyKey(userId: number, expiresEpochSeconds: number, nonce: string): string {
  return buildAccountMailKey("password-reset-v1", userId, expiresEpochSeconds, nonce);
}

export function parsePasswordResetIdempotencyKey(value: string): AccountMailIdentity | null {
  return parseAccountMailKey(PASSWORD_RESET_KEY_PATTERN, value);
}

export function computeMailRecipientAuditHmac(
  toEmail: string,
  keyring: TokenHmacKeyring,
  keyVersion: number,
): string {
  const canonicalEmail = canonicalizeEmail(toEmail);
  const encryptionKey = decodeEncryptionKey(keyring, keyVersion);
  const auditKey = Buffer.from(
    hkdfSync(
      "sha256",
      encryptionKey,
      Buffer.alloc(0),
      MAIL_RECIPIENT_AUDIT_KEY_INFO,
      32,
    ),
  );
  const digest = createHmac("sha256", auditKey)
    .update(canonicalEmail, "utf8")
    .digest("base64url");

  return `v${keyVersion}.${digest}`;
}

function serializeAad(
  idempotencyKey: string,
  toEmail: string,
  template: MailTemplate,
  keyVersion: number,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      idempotency_key: idempotencyKey,
      to_email: toEmail,
      template,
      key_version: keyVersion,
    }),
    "utf8",
  );
}

function assertPlaintextForTemplate(template: MailTemplate, plaintext: string): void {
  const valid =
    template === "verification_code"
      ? REGISTRATION_OTP_PATTERN.test(plaintext)
      : template === "password_reset"
        ? PASSWORD_RESET_TOKEN_PATTERN.test(plaintext)
        : template === "email_changed_notice" && plaintext === EMAIL_CHANGED_NOTICE_PLAINTEXT;
  if (!valid) {
    throw new Error("Mail outbox payload is invalid");
  }
}

export function encryptMailPayload(
  input: {
    readonly idempotencyKey: string;
    readonly toEmail: string;
    readonly template: MailTemplate;
    readonly plaintext: string;
  },
  keyring: TokenHmacKeyring,
  randomBytesSource: MailOutboxRandomBytesSource = randomBytes,
): EncryptedRegistrationOtpPayload {
  assertPlaintextForTemplate(input.template, input.plaintext);
  const toEmail = canonicalizeEmail(input.toEmail);
  const keyVersion = keyring.version;
  const key = decodeEncryptionKey(keyring, keyVersion);
  const nonce = randomBytesSource(MAIL_OUTBOX_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== MAIL_OUTBOX_NONCE_BYTES) {
    throw new Error("Registration outbox nonce generation failed");
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: MAIL_OUTBOX_AUTH_TAG_BYTES,
  });
  cipher.setAAD(
    serializeAad(input.idempotencyKey, toEmail, input.template, keyVersion),
  );
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "ascii"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== MAIL_OUTBOX_AUTH_TAG_BYTES) {
    throw new Error("Registration outbox authentication tag is invalid");
  }

  return {
    idempotencyKey: input.idempotencyKey,
    toEmail,
    template: input.template,
    keyVersion,
    nonce,
    ciphertext,
    tag,
  };
}

export function encryptRegistrationOtpPayload(
  input: {
    readonly pendingRegistrationId: number;
    readonly otpGeneration: number;
    readonly toEmail: string;
    readonly otp: string;
  },
  keyring: TokenHmacKeyring,
  randomBytesSource: MailOutboxRandomBytesSource = randomBytes,
): EncryptedRegistrationOtpPayload {
  if (!REGISTRATION_OTP_PATTERN.test(input.otp)) {
    throw new Error("Registration outbox input is invalid");
  }
  return encryptMailPayload(
    {
      idempotencyKey: buildRegistrationOtpIdempotencyKey(
        input.pendingRegistrationId,
        input.otpGeneration,
      ),
      toEmail: input.toEmail,
      template: "verification_code",
      plaintext: input.otp,
    },
    keyring,
    randomBytesSource,
  );
}

/** Decrypts any outbox payload and checks it matches its template. */
export function decryptMailPayload(
  encrypted: EncryptedRegistrationOtpPayload,
  keyring: TokenHmacKeyring,
): string {
  if (
    encrypted.nonce.length !== MAIL_OUTBOX_NONCE_BYTES ||
    encrypted.tag.length !== MAIL_OUTBOX_AUTH_TAG_BYTES ||
    !isMailTemplate(encrypted.template)
  ) {
    throw new Error("Registration outbox payload is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeEncryptionKey(keyring, encrypted.keyVersion),
    encrypted.nonce,
    { authTagLength: MAIL_OUTBOX_AUTH_TAG_BYTES },
  );
  decipher.setAAD(
    serializeAad(
      encrypted.idempotencyKey,
      canonicalizeEmail(encrypted.toEmail),
      encrypted.template,
      encrypted.keyVersion,
    ),
  );
  decipher.setAuthTag(encrypted.tag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString("ascii");
  assertPlaintextForTemplate(encrypted.template, plaintext);
  return plaintext;
}

export function decryptRegistrationOtpPayload(
  encrypted: EncryptedRegistrationOtpPayload,
  keyring: TokenHmacKeyring,
): string {
  if (encrypted.template !== "verification_code") {
    throw new Error("Registration outbox payload is invalid");
  }
  return decryptMailPayload(encrypted, keyring);
}

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

export interface EncryptedRegistrationOtpPayload {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly template: "verification_code";
  readonly keyVersion: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
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
  template: "verification_code",
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
  const toEmail = canonicalizeEmail(input.toEmail);
  const keyVersion = keyring.version;
  const key = decodeEncryptionKey(keyring, keyVersion);
  const idempotencyKey = buildRegistrationOtpIdempotencyKey(
    input.pendingRegistrationId,
    input.otpGeneration,
  );
  const nonce = randomBytesSource(MAIL_OUTBOX_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== MAIL_OUTBOX_NONCE_BYTES) {
    throw new Error("Registration outbox nonce generation failed");
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: MAIL_OUTBOX_AUTH_TAG_BYTES,
  });
  cipher.setAAD(
    serializeAad(idempotencyKey, toEmail, "verification_code", keyVersion),
  );
  const ciphertext = Buffer.concat([
    cipher.update(input.otp, "ascii"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== MAIL_OUTBOX_AUTH_TAG_BYTES) {
    throw new Error("Registration outbox authentication tag is invalid");
  }

  return {
    idempotencyKey,
    toEmail,
    template: "verification_code",
    keyVersion,
    nonce,
    ciphertext,
    tag,
  };
}

export function decryptRegistrationOtpPayload(
  encrypted: EncryptedRegistrationOtpPayload,
  keyring: TokenHmacKeyring,
): string {
  if (
    encrypted.nonce.length !== MAIL_OUTBOX_NONCE_BYTES ||
    encrypted.tag.length !== MAIL_OUTBOX_AUTH_TAG_BYTES ||
    encrypted.template !== "verification_code"
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
  const otp = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString("ascii");
  if (!REGISTRATION_OTP_PATTERN.test(otp)) {
    throw new Error("Registration outbox payload is invalid");
  }
  return otp;
}

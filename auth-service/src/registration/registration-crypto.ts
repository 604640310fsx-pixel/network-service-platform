import {
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import type { TokenHmacKeyring } from "../session/session-token.js";

export const REGISTRATION_TOKEN_PATTERN =
  /^v([0-9]+)\.([A-Za-z0-9_-]{43})$/;
export const REGISTRATION_OTP_PATTERN = /^[0-9]{6}$/;
export const REGISTRATION_TOKEN_RANDOM_BYTES = 32;
export const REGISTRATION_HASH_LENGTH = 43;

const EMPTY_HKDF_SALT = Buffer.alloc(0);
const REGISTRATION_TOKEN_HKDF_INFO = Buffer.from(
  "registration-token-v1",
  "utf8",
);
const REGISTRATION_OTP_HKDF_INFO = Buffer.from(
  "registration-otp-v1",
  "utf8",
);
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface RegistrationTokenMaterial {
  readonly rawToken: string;
  readonly tokenHash: string;
  readonly hmacKeyVersion: number;
}

export type RegistrationRandomBytesSource = (size: number) => Buffer;
export type RegistrationRandomIntSource = (
  minimum: number,
  maximum: number,
) => number;

export class RegistrationCryptoError extends Error {
  constructor() {
    super("Registration cryptographic operation failed");
    this.name = "RegistrationCryptoError";
  }
}

function assertKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RegistrationCryptoError();
  }
}

function decodeMasterKey(
  keyring: TokenHmacKeyring,
  version: number,
): Buffer {
  assertKeyVersion(version);
  const encodedKey = keyring.keys[String(version)];
  if (
    encodedKey === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encodedKey)
  ) {
    throw new RegistrationCryptoError();
  }

  const decodedKey = Buffer.from(encodedKey, "base64");
  if (
    decodedKey.length !== 32 ||
    decodedKey.toString("base64") !== encodedKey
  ) {
    throw new RegistrationCryptoError();
  }
  return decodedKey;
}

function deriveKey(masterKey: Buffer, info: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, EMPTY_HKDF_SALT, info, 32),
  );
}

function hmacBase64Url(key: Buffer, input: string): string {
  const output = createHmac("sha256", key)
    .update(input, "ascii")
    .digest("base64url");
  if (output.length !== REGISTRATION_HASH_LENGTH) {
    throw new RegistrationCryptoError();
  }
  return output;
}

function parseRegistrationTokenVersion(rawToken: string): number {
  const match = REGISTRATION_TOKEN_PATTERN.exec(rawToken);
  const versionText = match?.[1];
  if (versionText === undefined) {
    throw new RegistrationCryptoError();
  }
  const version = Number(versionText);
  assertKeyVersion(version);
  return version;
}

export function computeRegistrationTokenHash(
  rawToken: string,
  keyring: TokenHmacKeyring,
): Pick<RegistrationTokenMaterial, "tokenHash" | "hmacKeyVersion"> {
  const hmacKeyVersion = parseRegistrationTokenVersion(rawToken);
  const derivedKey = deriveKey(
    decodeMasterKey(keyring, hmacKeyVersion),
    REGISTRATION_TOKEN_HKDF_INFO,
  );
  return {
    tokenHash: hmacBase64Url(derivedKey, rawToken),
    hmacKeyVersion,
  };
}

export function generateRegistrationToken(
  keyring: TokenHmacKeyring,
  randomBytesSource: RegistrationRandomBytesSource = randomBytes,
): RegistrationTokenMaterial {
  assertKeyVersion(keyring.version);
  const random = randomBytesSource(REGISTRATION_TOKEN_RANDOM_BYTES);
  if (
    !Buffer.isBuffer(random) ||
    random.length !== REGISTRATION_TOKEN_RANDOM_BYTES
  ) {
    throw new RegistrationCryptoError();
  }

  const rawToken = `v${keyring.version}.${random.toString("base64url")}`;
  const { tokenHash, hmacKeyVersion } = computeRegistrationTokenHash(
    rawToken,
    keyring,
  );
  return { rawToken, tokenHash, hmacKeyVersion };
}

export function computeRegistrationOtpHash(
  otp: string,
  otpKeyVersion: number,
  keyring: TokenHmacKeyring,
): string {
  if (!REGISTRATION_OTP_PATTERN.test(otp)) {
    throw new RegistrationCryptoError();
  }
  const derivedKey = deriveKey(
    decodeMasterKey(keyring, otpKeyVersion),
    REGISTRATION_OTP_HKDF_INFO,
  );
  return hmacBase64Url(derivedKey, otp);
}

export function verifyRegistrationOtp(
  otp: string,
  expectedHash: string,
  otpKeyVersion: number,
  keyring: TokenHmacKeyring,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedHash)) {
    throw new RegistrationCryptoError();
  }
  const actualHash = computeRegistrationOtpHash(
    otp,
    otpKeyVersion,
    keyring,
  );
  return timingSafeEqual(
    Buffer.from(actualHash, "ascii"),
    Buffer.from(expectedHash, "ascii"),
  );
}

export function generateRegistrationOtp(
  randomIntSource: RegistrationRandomIntSource = randomInt,
): string {
  const value = randomIntSource(0, 1_000_000);
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000) {
    throw new RegistrationCryptoError();
  }
  return String(value).padStart(6, "0");
}

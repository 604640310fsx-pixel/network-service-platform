import { createHmac, hkdfSync, randomBytes } from "node:crypto";

export const SESSION_TOKEN_PATTERN =
  /^v([0-9]+)\.([A-Za-z0-9_-]{43})$/;
export const SESSION_TOKEN_RANDOM_BYTES = 32;
export const SESSION_TOKEN_HASH_LENGTH = 43;

const SESSION_TOKEN_HKDF_INFO = Buffer.from("session-token-v1", "utf8");
const EMPTY_HKDF_SALT = Buffer.alloc(0);
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface TokenHmacKeyring {
  readonly version: number;
  readonly keys: Readonly<Record<string, string>>;
}

export interface SessionTokenMaterial {
  readonly rawToken: string;
  readonly tokenHash: string;
  readonly hmacKeyVersion: number;
}

export type RandomBytesSource = (size: number) => Buffer;

export class SessionTokenOperationError extends Error {
  constructor() {
    super("Session token operation failed");
    this.name = "SessionTokenOperationError";
  }
}

function assertKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new SessionTokenOperationError();
  }
}

function parseTokenVersion(rawToken: string): number {
  const match = SESSION_TOKEN_PATTERN.exec(rawToken);
  if (match === null) {
    throw new SessionTokenOperationError();
  }

  const versionText = match[1];
  if (versionText === undefined) {
    throw new SessionTokenOperationError();
  }

  const version = Number(versionText);
  assertKeyVersion(version);
  return version;
}

function decodeMasterKey(keyring: TokenHmacKeyring, version: number): Buffer {
  assertKeyVersion(version);
  const encodedKey = keyring.keys[String(version)];

  if (
    encodedKey === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encodedKey)
  ) {
    throw new SessionTokenOperationError();
  }

  const decodedKey = Buffer.from(encodedKey, "base64");
  if (
    decodedKey.length !== 32 ||
    decodedKey.toString("base64") !== encodedKey
  ) {
    throw new SessionTokenOperationError();
  }

  return decodedKey;
}

function deriveSessionTokenKey(masterKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      EMPTY_HKDF_SALT,
      SESSION_TOKEN_HKDF_INFO,
      32,
    ),
  );
}

export function computeSessionTokenHash(
  rawToken: string,
  keyring: TokenHmacKeyring,
): Pick<SessionTokenMaterial, "tokenHash" | "hmacKeyVersion"> {
  const hmacKeyVersion = parseTokenVersion(rawToken);
  const masterKey = decodeMasterKey(keyring, hmacKeyVersion);
  const derivedKey = deriveSessionTokenKey(masterKey);
  const tokenHash = createHmac("sha256", derivedKey)
    .update(rawToken, "ascii")
    .digest("base64url");

  if (tokenHash.length !== SESSION_TOKEN_HASH_LENGTH) {
    throw new SessionTokenOperationError();
  }

  return { tokenHash, hmacKeyVersion };
}

export function generateSessionToken(
  keyring: TokenHmacKeyring,
  randomBytesSource: RandomBytesSource = randomBytes,
): SessionTokenMaterial {
  assertKeyVersion(keyring.version);
  const random = randomBytesSource(SESSION_TOKEN_RANDOM_BYTES);
  if (!Buffer.isBuffer(random) || random.length !== SESSION_TOKEN_RANDOM_BYTES) {
    throw new SessionTokenOperationError();
  }

  const rawToken = `v${keyring.version}.${random.toString("base64url")}`;
  const { tokenHash, hmacKeyVersion } = computeSessionTokenHash(
    rawToken,
    keyring,
  );

  return { rawToken, tokenHash, hmacKeyVersion };
}

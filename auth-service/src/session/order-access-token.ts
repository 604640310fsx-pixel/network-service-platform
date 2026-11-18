import { createHmac, hkdfSync } from "node:crypto";

import type { TokenHmacKeyring } from "./session-token.js";

export const ORDER_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ORDER_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const EMPTY_HKDF_SALT = Buffer.alloc(0);
const ORDER_ACCESS_TOKEN_HKDF_INFO = Buffer.from(
  "order-access-token-v1",
  "utf8",
);
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface OrderAccessTokenHash {
  readonly tokenHash: string;
  readonly tokenKeyVersion: number;
}

export class OrderAccessTokenError extends Error {
  constructor() {
    super("Order access token is invalid");
    this.name = "OrderAccessTokenError";
  }
}

function decodeRawToken(rawToken: string): Buffer {
  if (!ORDER_ACCESS_TOKEN_PATTERN.test(rawToken)) {
    throw new OrderAccessTokenError();
  }
  const decoded = Buffer.from(rawToken, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== rawToken) {
    throw new OrderAccessTokenError();
  }
  return decoded;
}

function decodeMasterKey(
  keyring: TokenHmacKeyring,
  version: number,
): Buffer {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new OrderAccessTokenError();
  }
  const encoded = keyring.keys[String(version)];
  if (encoded === undefined || !BASE64_32_BYTE_KEY_PATTERN.test(encoded)) {
    throw new OrderAccessTokenError();
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new OrderAccessTokenError();
  }
  return decoded;
}

export function computeOrderAccessTokenHash(
  rawToken: string,
  keyring: TokenHmacKeyring,
  version = keyring.version,
): OrderAccessTokenHash {
  decodeRawToken(rawToken);
  const masterKey = decodeMasterKey(keyring, version);
  const derivedKey = Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      EMPTY_HKDF_SALT,
      ORDER_ACCESS_TOKEN_HKDF_INFO,
      32,
    ),
  );
  const tokenHash = createHmac("sha256", derivedKey)
    .update(rawToken, "ascii")
    .digest("base64url");

  if (tokenHash.length !== 43) {
    throw new OrderAccessTokenError();
  }
  return { tokenHash, tokenKeyVersion: version };
}

export function orderAccessTokenExpiry(createdAt: Date): string {
  const value = createdAt.getTime();
  if (!Number.isFinite(value)) {
    throw new OrderAccessTokenError();
  }
  return new Date(value + ORDER_ACCESS_TOKEN_TTL_MS).toISOString();
}

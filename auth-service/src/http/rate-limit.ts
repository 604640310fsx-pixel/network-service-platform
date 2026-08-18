import { createHmac, hkdfSync } from "node:crypto";
import { isIP } from "node:net";

import type { DatabaseConnection } from "../db.js";

export interface RateLimitKeyring {
  readonly version: number;
  readonly keys: Readonly<Record<string, string>>;
}

export interface LoginRateLimitInput {
  readonly ip: string;
  readonly canonicalEmail: string;
}

export interface LoginRateLimitDependencies {
  readonly now?: () => Date;
}

export const LOGIN_IP_LIMIT = 20;
export const LOGIN_ACCOUNT_LIMIT = 10;
export const RATE_LIMIT_BUCKET_SECONDS = 300;
export const RATE_LIMIT_WINDOW_SECONDS = 3_600;

const EMPTY_HKDF_SALT = Buffer.alloc(0);
const RATE_LIMIT_HKDF_INFO = Buffer.from("rate-limit-v1", "utf8");
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export class RateLimitExceededError extends Error {
  readonly code = "rate_limited";

  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

function decodeKey(keyring: RateLimitKeyring, version: number): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    encoded === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encoded)
  ) {
    throw new Error("Rate-limit keyring is invalid");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error("Rate-limit keyring is invalid");
  }
  return decoded;
}

function keyVersions(keyring: RateLimitKeyring): readonly number[] {
  if (!Number.isSafeInteger(keyring.version) || keyring.version < 0) {
    throw new Error("Rate-limit keyring is invalid");
  }
  decodeKey(keyring, keyring.version);

  const previous = Object.keys(keyring.keys)
    .filter((value) => /^(0|[1-9][0-9]*)$/.test(value))
    .map(Number)
    .filter((version) => version < keyring.version)
    .sort((left, right) => right - left)[0];

  if (previous === undefined) {
    return [keyring.version];
  }
  decodeKey(keyring, previous);
  return [keyring.version, previous];
}

function lengthPrefixed(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

export function computeRateLimitBucketKey(
  keyring: RateLimitKeyring,
  version: number,
  purpose: string,
  identifier: string,
): string {
  const derivedKey = Buffer.from(
    hkdfSync(
      "sha256",
      decodeKey(keyring, version),
      EMPTY_HKDF_SALT,
      RATE_LIMIT_HKDF_INFO,
      32,
    ),
  );
  const input = Buffer.concat([
    lengthPrefixed(purpose),
    lengthPrefixed(identifier),
  ]);
  const output = createHmac("sha256", derivedKey)
    .update(input)
    .digest("base64url");
  if (output.length !== 43) {
    throw new Error("Rate-limit bucket key generation failed");
  }
  return output;
}

export function canonicalizeIp(input: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(input)?.[1];
  if (mapped !== undefined && isIP(mapped) === 4) {
    return mapped;
  }
  if (isIP(input) === 4) {
    return input;
  }
  if (isIP(input) === 6) {
    const hostname = new URL(`http://[${input}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  throw new Error("Client IP is invalid");
}

function rateLimitTimes(nowSource: () => Date): {
  readonly now: string;
  readonly windowStart: string;
  readonly windowFloor: string;
} {
  const date = nowSource();
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Rate-limit time source is invalid");
  }
  const nowEpochSeconds = Math.floor(milliseconds / 1_000);
  const currentBucketEpoch =
    Math.floor(nowEpochSeconds / RATE_LIMIT_BUCKET_SECONDS) *
    RATE_LIMIT_BUCKET_SECONDS;
  const windowFloorEpoch =
    Math.floor(
      (nowEpochSeconds - RATE_LIMIT_WINDOW_SECONDS) /
        RATE_LIMIT_BUCKET_SECONDS,
    ) * RATE_LIMIT_BUCKET_SECONDS;

  return {
    now: date.toISOString(),
    windowStart: new Date(currentBucketEpoch * 1_000).toISOString(),
    windowFloor: new Date(windowFloorEpoch * 1_000).toISOString(),
  };
}

function countForKeys(
  database: DatabaseConnection,
  keys: readonly string[],
  windowFloor: string,
): number {
  const placeholders = keys.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS total
       FROM rate_limit_buckets
       WHERE bucket_key IN (${placeholders}) AND window_start >= ?`,
    )
    .all(...keys, windowFloor) as Array<{ readonly total: unknown }>;
  const total = rows[0]?.total;
  if (typeof total !== "number") {
    throw new Error("Rate-limit count is invalid");
  }
  return total;
}

function increment(
  database: DatabaseConnection,
  key: string,
  windowStart: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (bucket_key, window_start)
       DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    )
    .run(key, windowStart, now);
}

export function consumeLoginRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: LoginRateLimitInput,
  dependencies: LoginRateLimitDependencies = {},
): void {
  const versions = keyVersions(keyring);
  const ip = canonicalizeIp(input.ip);
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const ipKeys = versions.map((version) =>
    computeRateLimitBucketKey(keyring, version, "login:ip", ip),
  );
  const accountKeys = versions.map((version) =>
    computeRateLimitBucketKey(
      keyring,
      version,
      "login:account",
      input.canonicalEmail,
    ),
  );

  const consume = database.transaction(() => {
    if (countForKeys(database, ipKeys, times.windowFloor) >= LOGIN_IP_LIMIT) {
      throw new RateLimitExceededError();
    }
    if (
      countForKeys(database, accountKeys, times.windowFloor) >=
      LOGIN_ACCOUNT_LIMIT
    ) {
      throw new RateLimitExceededError();
    }

    increment(database, ipKeys[0]!, times.windowStart, times.now);
    increment(database, accountKeys[0]!, times.windowStart, times.now);
  });

  consume.immediate();
}

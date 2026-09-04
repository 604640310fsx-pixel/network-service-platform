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

export interface RegistrationStartRateLimitInput {
  readonly ip: string;
  readonly canonicalEmail: string;
  readonly inviteHashIdentifiers: readonly string[];
}

export interface RegistrationResendRateLimitInput {
  readonly ip: string;
  readonly canonicalEmail: string;
}

export type RegistrationIpRateLimitPurpose =
  | "register:resend:ip"
  | "register:verify:ip"
  | "register:complete:ip";

export interface RegistrationRateLimitDependencies {
  readonly now?: () => Date;
}

export interface DiagnosisRateLimitDependencies {
  readonly now?: () => Date;
}

export const LOGIN_IP_LIMIT = 20;
export const LOGIN_ACCOUNT_LIMIT = 10;
export const REGISTRATION_START_IP_LIMIT = 10;
export const REGISTRATION_START_EMAIL_LIMIT = 5;
export const REGISTRATION_START_INVITE_LIMIT = 5;
export const REGISTRATION_RESEND_IP_LIMIT = 20;
export const REGISTRATION_RESEND_EMAIL_LIMIT = 5;
export const REGISTRATION_VERIFY_IP_LIMIT = 30;
export const REGISTRATION_COMPLETE_IP_LIMIT = 20;
export const DIAGNOSIS_SUBMIT_IP_LIMIT = 5;
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

interface RateLimitDimension {
  readonly readKeys: readonly string[];
  readonly writeKey: string;
  readonly limit: number;
}

function consumeDimensions(
  database: DatabaseConnection,
  dimensions: readonly RateLimitDimension[],
  times: ReturnType<typeof rateLimitTimes>,
): void {
  const consume = database.transaction(() => {
    consumeDimensionRows(database, dimensions, times);
  });

  consume.immediate();
}

function consumeDimensionRows(
  database: DatabaseConnection,
  dimensions: readonly RateLimitDimension[],
  times: ReturnType<typeof rateLimitTimes>,
): void {
  for (const dimension of dimensions) {
    if (
      countForKeys(database, dimension.readKeys, times.windowFloor) >=
      dimension.limit
    ) {
      throw new RateLimitExceededError();
    }
  }
  for (const dimension of dimensions) {
    increment(database, dimension.writeKey, times.windowStart, times.now);
  }
}

function dimension(
  keyring: RateLimitKeyring,
  purpose: string,
  identifiers: readonly string[],
  limit: number,
): RateLimitDimension {
  const versions = keyVersions(keyring);
  const readKeys = versions.flatMap((version) =>
    identifiers.map((identifier) =>
      computeRateLimitBucketKey(keyring, version, purpose, identifier),
    ),
  );
  return {
    readKeys: [...new Set(readKeys)],
    writeKey: computeRateLimitBucketKey(
      keyring,
      keyring.version,
      purpose,
      identifiers[0]!,
    ),
    limit,
  };
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

  consumeDimensions(
    database,
    [
      { readKeys: ipKeys, writeKey: ipKeys[0]!, limit: LOGIN_IP_LIMIT },
      {
        readKeys: accountKeys,
        writeKey: accountKeys[0]!,
        limit: LOGIN_ACCOUNT_LIMIT,
      },
    ],
    times,
  );
}

export function consumeRegistrationStartRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: RegistrationStartRateLimitInput,
  dependencies: RegistrationRateLimitDependencies = {},
): void {
  if (input.inviteHashIdentifiers.length === 0) {
    throw new Error("Registration invite rate-limit identifiers are invalid");
  }
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  consumeDimensions(
    database,
    [
      dimension(
        keyring,
        "register:start:ip",
        [canonicalizeIp(input.ip)],
        REGISTRATION_START_IP_LIMIT,
      ),
      dimension(
        keyring,
        "register:start:email",
        [input.canonicalEmail],
        REGISTRATION_START_EMAIL_LIMIT,
      ),
      dimension(
        keyring,
        "register:start:invite",
        input.inviteHashIdentifiers,
        REGISTRATION_START_INVITE_LIMIT,
      ),
    ],
    times,
  );
}

export function consumeRegistrationIpRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  purpose: RegistrationIpRateLimitPurpose,
  ip: string,
  dependencies: RegistrationRateLimitDependencies = {},
): void {
  const limits: Record<RegistrationIpRateLimitPurpose, number> = {
    "register:resend:ip": REGISTRATION_RESEND_IP_LIMIT,
    "register:verify:ip": REGISTRATION_VERIFY_IP_LIMIT,
    "register:complete:ip": REGISTRATION_COMPLETE_IP_LIMIT,
  };
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  consumeDimensions(
    database,
    [dimension(keyring, purpose, [canonicalizeIp(ip)], limits[purpose])],
    times,
  );
}

export function consumeDiagnosisSubmitRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  ip: string,
  dependencies: DiagnosisRateLimitDependencies = {},
): void {
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  consumeDimensions(
    database,
    [
      dimension(
        keyring,
        "diagnosis:submit:ip",
        [canonicalizeIp(ip)],
        DIAGNOSIS_SUBMIT_IP_LIMIT,
      ),
    ],
    times,
  );
}

export function withDiagnosisSubmitRateLimit<Result>(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  ip: string,
  operation: (consumeRateLimit: () => void) => Result,
  dependencies: DiagnosisRateLimitDependencies = {},
): Result {
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const dimensions = [
    dimension(
      keyring,
      "diagnosis:submit:ip",
      [canonicalizeIp(ip)],
      DIAGNOSIS_SUBMIT_IP_LIMIT,
    ),
  ];
  const transaction = database.transaction(() => {
    let consumed = false;
    return operation(() => {
      if (consumed) {
        throw new Error("Diagnosis rate limit was consumed more than once");
      }
      consumed = true;
      consumeDimensionRows(database, dimensions, times);
    });
  });
  return transaction.immediate();
}

export function consumeRegistrationResendRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: RegistrationResendRateLimitInput,
  dependencies: RegistrationRateLimitDependencies = {},
): { readonly emailSilenced: boolean } {
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const ipDimension = dimension(
    keyring,
    "register:resend:ip",
    [canonicalizeIp(input.ip)],
    REGISTRATION_RESEND_IP_LIMIT,
  );
  const emailDimension = dimension(
    keyring,
    "register:resend:email",
    [input.canonicalEmail],
    REGISTRATION_RESEND_EMAIL_LIMIT,
  );
  const consume = database.transaction(() => {
    if (
      countForKeys(database, ipDimension.readKeys, times.windowFloor) >=
      ipDimension.limit
    ) {
      throw new RateLimitExceededError();
    }
    if (
      countForKeys(database, emailDimension.readKeys, times.windowFloor) >=
      emailDimension.limit
    ) {
      increment(
        database,
        ipDimension.writeKey,
        times.windowStart,
        times.now,
      );
      return { emailSilenced: true } as const;
    }
    increment(
      database,
      ipDimension.writeKey,
      times.windowStart,
      times.now,
    );
    increment(
      database,
      emailDimension.writeKey,
      times.windowStart,
      times.now,
    );
    return { emailSilenced: false } as const;
  });

  return consume.immediate();
}

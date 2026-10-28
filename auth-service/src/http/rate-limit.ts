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

// Exactly one code dimension: the legacy admin invite hashes (one-time per-invite
// cap) or a personal invite code (its own separate, bounded bucket), so shared
// use of a personal code never consumes the legacy per-invite budget.
export type RegistrationStartRateLimitInput =
  | {
      readonly ip: string;
      readonly inviteHashIdentifiers: readonly string[];
      readonly personalCodeIdentifier?: undefined;
    }
  | {
      readonly ip: string;
      readonly inviteHashIdentifiers?: undefined;
      readonly personalCodeIdentifier: string;
    };

export interface RegistrationStartRateLimitControl {
  readonly inviteSilenced: boolean;
  consumeEmail(canonicalEmail: string): {
    readonly emailSilenced: boolean;
  };
}

export interface RegistrationResendRateLimitInput {
  readonly ip: string;
  readonly canonicalEmail: string;
}

export interface RegistrationResendRateLimitControl {
  consumeEmail(canonicalEmail: string): {
    readonly emailSilenced: boolean;
  };
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
export const REGISTRATION_START_PERSONAL_CODE_LIMIT = 20;
export const REGISTRATION_RESEND_IP_LIMIT = 20;
export const REGISTRATION_RESEND_EMAIL_LIMIT = 5;
export const REGISTRATION_VERIFY_IP_LIMIT = 30;
export const REGISTRATION_COMPLETE_IP_LIMIT = 20;
export const DIAGNOSIS_SUBMIT_IP_LIMIT = 5;
export const MONITOR_STATUS_USER_LIMIT = 120;
export const TICKET_ATTACHMENT_WRITE_USER_LIMIT = 10;
// Traffic panel: one request per delivered line (≤20) per page load; upstream reads are cached 60s.
export const SUBSCRIPTION_INFO_USER_LIMIT = 240;
export const ACCOUNT_PASSWORD_CHANGE_USER_LIMIT = 10;
export const ACCOUNT_EMAIL_CHANGE_START_USER_LIMIT = 5;
export const ACCOUNT_EMAIL_CHANGE_START_TARGET_LIMIT = 5;
export const ACCOUNT_EMAIL_CHANGE_CONFIRM_USER_LIMIT = 10;
export const PASSWORD_RESET_REQUEST_IP_LIMIT = 10;
export const PASSWORD_RESET_REQUEST_EMAIL_LIMIT = 5;
export const PASSWORD_RESET_CONFIRM_IP_LIMIT = 20;
export const RATE_LIMIT_BUCKET_SECONDS = 300;
export const RATE_LIMIT_WINDOW_SECONDS = 3_600;
const TICKET_ATTACHMENT_BUCKET_SECONDS = 60;
const TICKET_ATTACHMENT_WINDOW_SECONDS = 60;

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

function rateLimitTimes(
  nowSource: () => Date,
  bucketSeconds: number = RATE_LIMIT_BUCKET_SECONDS,
  windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): {
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
    Math.floor(nowEpochSeconds / bucketSeconds) *
    bucketSeconds;
  const windowFloorEpoch =
    Math.floor(
      (nowEpochSeconds - windowSeconds) /
        bucketSeconds,
    ) * bucketSeconds;

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

export function consumeMonitorStatusRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  userId: number,
  dependencies: { readonly now?: () => Date } = {},
): void {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Monitor rate-limit principal is invalid");
  }
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  consumeDimensions(
    database,
    [
      dimension(
        keyring,
        "monitor:status:user",
        [String(userId)],
        MONITOR_STATUS_USER_LIMIT,
      ),
    ],
    times,
  );
}

/* 附件上传写：除既有会话/CSRF 闸门外，每个账户每分钟最多 10 次携带附件的
   工单创建或回复。窗口与桶独立成 60s，严格对应每分钟上限。 */
export function consumeTicketAttachmentWriteRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  userId: number,
  dependencies: { readonly now?: () => Date } = {},
): void {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Ticket attachment rate-limit principal is invalid");
  }
  const times = rateLimitTimes(
    dependencies.now ?? (() => new Date()),
    TICKET_ATTACHMENT_BUCKET_SECONDS,
    TICKET_ATTACHMENT_WINDOW_SECONDS,
  );
  consumeDimensions(
    database,
    [
      dimension(
        keyring,
        "ticket:attachment-write:user",
        [String(userId)],
        TICKET_ATTACHMENT_WRITE_USER_LIMIT,
      ),
    ],
    times,
  );
}

export function consumeSubscriptionInfoRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  userId: number,
  dependencies: { readonly now?: () => Date } = {},
): void {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Subscription info rate-limit principal is invalid");
  }
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  consumeDimensions(
    database,
    [dimension(keyring, "subscription:info:user", [String(userId)], SUBSCRIPTION_INFO_USER_LIMIT)],
    times,
  );
}

export type AccountSecurityRateLimitInput =
  | { readonly purpose: "password_change"; readonly userId: number }
  | { readonly purpose: "email_change_start"; readonly userId: number; readonly canonicalNewEmail: string }
  | { readonly purpose: "email_change_confirm"; readonly userId: number };

/* Signed-in account security writes. Each attempt is counted before the
   password or code is checked, so a stolen session cannot brute-force the
   current password or the emailed code. Starting an email change is also
   bounded per target address, so one account cannot flood another inbox. */
export function consumeAccountSecurityRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: AccountSecurityRateLimitInput,
  dependencies: { readonly now?: () => Date } = {},
): void {
  if (!Number.isSafeInteger(input.userId) || input.userId < 1) {
    throw new Error("Account security rate-limit principal is invalid");
  }
  const user = String(input.userId);
  const dimensions =
    input.purpose === "password_change"
      ? [dimension(keyring, "account:password-change:user", [user], ACCOUNT_PASSWORD_CHANGE_USER_LIMIT)]
      : input.purpose === "email_change_confirm"
        ? [dimension(keyring, "account:email-change-confirm:user", [user], ACCOUNT_EMAIL_CHANGE_CONFIRM_USER_LIMIT)]
        : [
            dimension(keyring, "account:email-change-start:user", [user], ACCOUNT_EMAIL_CHANGE_START_USER_LIMIT),
            dimension(
              keyring,
              "account:email-change-start:target",
              [input.canonicalNewEmail],
              ACCOUNT_EMAIL_CHANGE_START_TARGET_LIMIT,
            ),
          ];
  consumeDimensions(database, dimensions, rateLimitTimes(dependencies.now ?? (() => new Date())));
}

export type PasswordResetRateLimitInput =
  | { readonly purpose: "request"; readonly ip: string; readonly canonicalEmail: string | null }
  | { readonly purpose: "confirm"; readonly ip: string };

/* Signed-out password reset. Requests are bounded per IP and per target
   address (the address bucket is counted whether or not an account exists,
   so the limit reveals nothing); confirms are bounded per IP. */
export function consumePasswordResetRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: PasswordResetRateLimitInput,
  dependencies: { readonly now?: () => Date } = {},
): void {
  const ip = canonicalizeIp(input.ip);
  const dimensions =
    input.purpose === "confirm"
      ? [dimension(keyring, "password-reset:confirm:ip", [ip], PASSWORD_RESET_CONFIRM_IP_LIMIT)]
      : [
          dimension(keyring, "password-reset:request:ip", [ip], PASSWORD_RESET_REQUEST_IP_LIMIT),
          ...(input.canonicalEmail === null
            ? []
            : [
                dimension(
                  keyring,
                  "password-reset:request:email",
                  [input.canonicalEmail],
                  PASSWORD_RESET_REQUEST_EMAIL_LIMIT,
                ),
              ]),
        ];
  consumeDimensions(database, dimensions, rateLimitTimes(dependencies.now ?? (() => new Date())));
}

export function withRegistrationStartRateLimit<Result>(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: RegistrationStartRateLimitInput,
  operation: (control: RegistrationStartRateLimitControl) => Result,
  dependencies: RegistrationRateLimitDependencies = {},
): Result {
  const personal = input.personalCodeIdentifier !== undefined;
  if (
    personal
      ? input.personalCodeIdentifier === ""
      : input.inviteHashIdentifiers === undefined || input.inviteHashIdentifiers.length === 0
  ) {
    throw new Error("Registration invite rate-limit identifiers are invalid");
  }
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const ipDimension = dimension(
    keyring,
    "register:start:ip",
    [canonicalizeIp(input.ip)],
    REGISTRATION_START_IP_LIMIT,
  );
  const inviteDimension = personal
    ? dimension(
        keyring,
        "register:start:personal",
        [input.personalCodeIdentifier],
        REGISTRATION_START_PERSONAL_CODE_LIMIT,
      )
    : dimension(
        keyring,
        "register:start:invite",
        input.inviteHashIdentifiers,
        REGISTRATION_START_INVITE_LIMIT,
      );
  const transaction = database.transaction(() => {
    if (
      countForKeys(database, ipDimension.readKeys, times.windowFloor) >=
      ipDimension.limit
    ) {
      throw new RateLimitExceededError();
    }
    increment(database, ipDimension.writeKey, times.windowStart, times.now);

    const inviteSilenced =
      countForKeys(database, inviteDimension.readKeys, times.windowFloor) >=
      inviteDimension.limit;
    if (!inviteSilenced) {
      increment(
        database,
        inviteDimension.writeKey,
        times.windowStart,
        times.now,
      );
    }

    let emailConsumed = false;
    return operation({
      inviteSilenced,
      consumeEmail(canonicalEmail) {
        if (emailConsumed || inviteSilenced) {
          throw new Error("Registration start email rate limit is invalid");
        }
        emailConsumed = true;
        const emailDimension = dimension(
          keyring,
          "register:start:email",
          [canonicalEmail],
          REGISTRATION_START_EMAIL_LIMIT,
        );
        const emailSilenced =
          countForKeys(database, emailDimension.readKeys, times.windowFloor) >=
          emailDimension.limit;
        if (!emailSilenced) {
          increment(
            database,
            emailDimension.writeKey,
            times.windowStart,
            times.now,
          );
        }
        return { emailSilenced };
      },
    });
  });
  return transaction.immediate();
}

export function consumeRegistrationIpRateLimit(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  purpose: RegistrationIpRateLimitPurpose,
  ip: string,
  dependencies: RegistrationRateLimitDependencies = {},
): void {
  withRegistrationIpRateLimit(
    database,
    keyring,
    purpose,
    ip,
    () => undefined,
    dependencies,
  );
}

export function withRegistrationIpRateLimit<Result>(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  purpose: RegistrationIpRateLimitPurpose,
  ip: string,
  operation: () => Result,
  dependencies: RegistrationRateLimitDependencies = {},
): Result {
  const limits: Record<RegistrationIpRateLimitPurpose, number> = {
    "register:resend:ip": REGISTRATION_RESEND_IP_LIMIT,
    "register:verify:ip": REGISTRATION_VERIFY_IP_LIMIT,
    "register:complete:ip": REGISTRATION_COMPLETE_IP_LIMIT,
  };
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const dimensions = [
    dimension(keyring, purpose, [canonicalizeIp(ip)], limits[purpose]),
  ];
  const transaction = database.transaction(() => {
    consumeDimensionRows(database, dimensions, times);
    return operation();
  });
  return transaction.immediate();
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
  return withRegistrationResendRateLimit(
    database,
    keyring,
    { ip: input.ip },
    (control) => control.consumeEmail(input.canonicalEmail),
    dependencies,
  );
}

export function withRegistrationResendRateLimit<Result>(
  database: DatabaseConnection,
  keyring: RateLimitKeyring,
  input: { readonly ip: string },
  operation: (control: RegistrationResendRateLimitControl) => Result,
  dependencies: RegistrationRateLimitDependencies = {},
): Result {
  const times = rateLimitTimes(dependencies.now ?? (() => new Date()));
  const ipDimension = dimension(
    keyring,
    "register:resend:ip",
    [canonicalizeIp(input.ip)],
    REGISTRATION_RESEND_IP_LIMIT,
  );
  const transaction = database.transaction(() => {
    if (
      countForKeys(database, ipDimension.readKeys, times.windowFloor) >=
      ipDimension.limit
    ) {
      throw new RateLimitExceededError();
    }
    increment(database, ipDimension.writeKey, times.windowStart, times.now);

    let emailConsumed = false;
    return operation({
      consumeEmail(canonicalEmail) {
        if (emailConsumed) {
          throw new Error("Registration resend email rate limit is invalid");
        }
        emailConsumed = true;
        const emailDimension = dimension(
          keyring,
          "register:resend:email",
          [canonicalEmail],
          REGISTRATION_RESEND_EMAIL_LIMIT,
        );
        const emailSilenced =
          countForKeys(database, emailDimension.readKeys, times.windowFloor) >=
          emailDimension.limit;
        if (!emailSilenced) {
          increment(
            database,
            emailDimension.writeKey,
            times.windowStart,
            times.now,
          );
        }
        return { emailSilenced };
      },
    });
  });
  return transaction.immediate();
}

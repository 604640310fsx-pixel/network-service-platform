import type { ReferralPublicLinkConfig } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  canonicalizeIp,
  computeRateLimitBucketKey,
  RateLimitExceededError,
  type RateLimitKeyring,
} from "../http/rate-limit.js";

export const REFERRAL_PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
export const REFERRAL_PUBLIC_RESOLVE_IP_LIMIT = 120;
const REFERRAL_PUBLIC_RESOLVE_WINDOW_MS = 60 * 60 * 1_000;
const REFERRAL_PUBLIC_RESOLVE_MAX_CLIENTS = 4_096;

export interface ReferralPublicRateLimiter {
  consume(ip: string): void;
}

interface RateWindow {
  readonly startedAt: number;
  readonly count: number;
}

export function createReferralPublicRateLimiter(
  keyring: RateLimitKeyring,
  options: {
    readonly now?: () => Date;
    readonly limit?: number;
    readonly windowMs?: number;
    readonly maxClients?: number;
  } = {},
): ReferralPublicRateLimiter {
  const nowSource = options.now ?? (() => new Date());
  const limit = options.limit ?? REFERRAL_PUBLIC_RESOLVE_IP_LIMIT;
  const windowMs = options.windowMs ?? REFERRAL_PUBLIC_RESOLVE_WINDOW_MS;
  const maxClients = options.maxClients ?? REFERRAL_PUBLIC_RESOLVE_MAX_CLIENTS;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(maxClients) ||
    maxClients < 1
  ) {
    throw new Error("Referral public rate-limit configuration is invalid");
  }

  const windows = new Map<string, RateWindow>();
  return Object.freeze({
    consume(ip: string): void {
      const nowValue = nowSource().getTime();
      if (!Number.isFinite(nowValue)) {
        throw new Error("Referral public rate-limit time is invalid");
      }
      const identifier = computeRateLimitBucketKey(
        keyring,
        keyring.version,
        "referral:resolve:ip",
        canonicalizeIp(ip),
      );
      const current = windows.get(identifier);
      if (current !== undefined && nowValue - current.startedAt < windowMs) {
        if (current.count >= limit) throw new RateLimitExceededError();
        windows.set(identifier, { ...current, count: current.count + 1 });
        return;
      }

      for (const [key, value] of windows) {
        if (nowValue - value.startedAt >= windowMs) windows.delete(key);
      }
      if (!windows.has(identifier) && windows.size >= maxClients) {
        throw new RateLimitExceededError();
      }
      windows.set(identifier, { startedAt: nowValue, count: 1 });
    },
  });
}

export function resolveReferralPublicCode(
  database: DatabaseConnection,
  publicCode: string,
): boolean {
  if (!REFERRAL_PUBLIC_CODE_PATTERN.test(publicCode)) return false;
  const rows = database
    .prepare(
      `SELECT 1 AS valid
       FROM referral_profiles
       WHERE public_code = ?`,
    )
    .all(publicCode);
  if (rows.length > 1) {
    throw new Error("Referral public code lookup returned multiple rows");
  }
  return rows.length === 1;
}

export function referralPublicLink(
  config: ReferralPublicLinkConfig,
  publicCode: string,
): string | null {
  if (!config.enabled) return null;
  if (!REFERRAL_PUBLIC_CODE_PATTERN.test(publicCode)) {
    throw new Error("Referral public code is invalid");
  }
  const target = new URL(config.path, `${config.origin}/`);
  target.searchParams.set("code", publicCode);
  return target.toString();
}

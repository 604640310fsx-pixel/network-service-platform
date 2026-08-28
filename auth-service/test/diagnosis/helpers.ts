import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { DiagnosisHttpDependencies } from "../../src/http/diagnosis-routes.js";
import type { RateLimitKeyring } from "../../src/http/rate-limit.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import { computeSessionTokenHash } from "../../src/session/session-token.js";
import { insertAuthenticationUser } from "../auth/helpers.js";
import { CSRF_KEY, TOKEN_KEYRING, insertWebSession } from "../payment/helpers.js";

export const DIAGNOSIS_NOW = new Date("2026-08-21T00:00:00.000Z");
export const RATE_LIMIT_KEYRING: RateLimitKeyring = {
  version: 1,
  keys: { "1": Buffer.alloc(32, 0x61).toString("base64") },
};

export const PUBLIC_HEADERS = {
  origin: "http://localhost:5173",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
} as const;

export function publicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactType: "wechat",
    contactValue: " contact-value ",
    businessScenario: "tiktok_content",
    targetRegion: " Japan ",
    problemTypes: ["platform_environment_issue"],
    problemDescription: " unstable platform access ",
    safetyAcknowledged: true,
    ...overrides,
  };
}

export function diagnosisDependencies(
  database: DatabaseConnection,
  overrides: Partial<DiagnosisHttpDependencies> = {},
): DiagnosisHttpDependencies {
  return {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: RATE_LIMIT_KEYRING,
    csrfSigningKey: CSRF_KEY,
    now: () => new Date(DIAGNOSIS_NOW),
    ...overrides,
  };
}

export function diagnosisApp(
  database: DatabaseConnection,
  overrides: Partial<DiagnosisHttpDependencies> = {},
) {
  return buildApp({
    diagnosis: diagnosisDependencies(database, overrides),
    payment: { enabled: false },
  });
}

export function createSession(
  database: DatabaseConnection,
  role: "user" | "admin",
  email: string,
): {
  readonly userId: number;
  readonly cookie: string;
  readonly csrf: string;
} {
  const userId = insertAuthenticationUser(database, {
    email,
    passwordHash: "test-password-hash",
    status: "active",
    role,
  });
  const session = insertWebSession(database, userId);
  const sessionTokenHash = computeSessionTokenHash(
    session.rawToken,
    TOKEN_KEYRING,
  ).tokenHash;
  return {
    userId,
    cookie: session.cookie,
    csrf: issueCsrfToken(CSRF_KEY, sessionTokenHash),
  };
}

export function firstNumber(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): number {
  const row = database.prepare(source).all(...parameters)[0] as
    | Record<string, unknown>
    | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number") {
    throw new Error("query did not return a number");
  }
  return value;
}

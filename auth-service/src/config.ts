import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RateLimitKeyring } from "./http/rate-limit.js";
import type { InviteHmacKeyring } from "./registration/invite-code.js";
import type { TokenHmacKeyring } from "./session/session-token.js";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export type RuntimeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly dbPath: string;
  readonly nodeEnv: RuntimeEnvironment;
  readonly registrationEnabled: boolean;
}

export interface AuthCredentialConfig {
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly inviteHmacKeyring: InviteHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly csrfSigningKey: Buffer;
}

const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const KEY_VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;

function requireValue(
  environment: NodeJS.ProcessEnv,
  name: "HOST" | "PORT" | "DB_PATH" | "NODE_ENV",
): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function parseNodeEnvironment(value: string): RuntimeEnvironment {
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }

  throw new Error("NODE_ENV must be development, test, or production");
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(requireValue(environment, "NODE_ENV"));
  const host = requireValue(environment, "HOST");

  if (host !== LOOPBACK_HOST) {
    throw new Error(`HOST must be exactly ${LOOPBACK_HOST}`);
  }

  const port = parsePort(requireValue(environment, "PORT"));
  const dbPath = requireValue(environment, "DB_PATH");
  const registrationEnabledValue = environment.REGISTRATION_ENABLED;
  if (
    registrationEnabledValue !== "true" &&
    registrationEnabledValue !== "false"
  ) {
    throw new Error("REGISTRATION_ENABLED must be exactly true or false");
  }

  return Object.freeze({
    host: LOOPBACK_HOST,
    port,
    dbPath,
    nodeEnv,
    registrationEnabled: registrationEnabledValue === "true",
  });
}

function decodeCanonicalKey(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64_32_BYTE_KEY_PATTERN.test(value)
  ) {
    throw new Error("Auth credential configuration is invalid");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("Auth credential configuration is invalid");
  }

  return decoded;
}

function parseKeyring(value: string): TokenHmacKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Auth credential configuration is invalid");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "keys,version" ||
    !("version" in parsed) ||
    !("keys" in parsed) ||
    !Number.isSafeInteger(parsed.version) ||
    typeof parsed.version !== "number" ||
    parsed.version < 0 ||
    typeof parsed.keys !== "object" ||
    parsed.keys === null ||
    Array.isArray(parsed.keys)
  ) {
    throw new Error("Auth credential configuration is invalid");
  }

  const keys = parsed.keys as Record<string, unknown>;
  const entries = Object.entries(keys);
  if (entries.length === 0) {
    throw new Error("Auth credential configuration is invalid");
  }

  const validatedKeys: Record<string, string> = {};
  for (const [version, key] of entries) {
    if (
      !KEY_VERSION_PATTERN.test(version) ||
      Number(version) > parsed.version
    ) {
      throw new Error("Auth credential configuration is invalid");
    }
    decodeCanonicalKey(key);
    validatedKeys[version] = key as string;
  }

  if (validatedKeys[String(parsed.version)] === undefined) {
    throw new Error("Auth credential configuration is invalid");
  }

  return Object.freeze({
    version: parsed.version,
    keys: Object.freeze(validatedKeys),
  });
}

function readCredential(directory: string, name: string): string {
  try {
    const value = readFileSync(resolve(directory, name), "utf8").trim();
    if (!value) {
      throw new Error("empty credential");
    }
    return value;
  } catch {
    throw new Error("Auth credential configuration is invalid");
  }
}

export function loadAuthCredentialConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuthCredentialConfig {
  const directory = environment.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) {
    throw new Error("Auth credential configuration is invalid");
  }

  const tokenHmacKeyring = parseKeyring(
    readCredential(directory, "token_hmac_keyring"),
  );
  const inviteHmacKeyring = parseKeyring(
    readCredential(directory, "invite_hmac_keyring"),
  );
  const mailPayloadEncKeyring = parseKeyring(
    readCredential(directory, "mail_payload_enc_keyring"),
  );
  const rateLimitKeyring = parseKeyring(
    readCredential(directory, "rate_limit_key"),
  );
  const csrfSigningKey = decodeCanonicalKey(
    readCredential(directory, "csrf_signing_key"),
  );

  return Object.freeze({
    tokenHmacKeyring,
    inviteHmacKeyring,
    mailPayloadEncKeyring,
    rateLimitKeyring,
    csrfSigningKey,
  });
}

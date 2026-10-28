import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalizeEmail } from "./auth/email.js";
import type { RateLimitKeyring } from "./http/rate-limit.js";
import type { InviteHmacKeyring } from "./registration/invite-code.js";
import type { TokenHmacKeyring } from "./session/session-token.js";
import {
  normalizeMonitorPrivateOrigin,
  type MonitorPrivateTlsCredentials,
} from "./monitor/private-client.js";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export type RuntimeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly dbPath: string;
  readonly nodeEnv: RuntimeEnvironment;
  readonly registrationEnabled: boolean;
  readonly paymentEnabled: boolean;
  readonly referralPublicLink: ReferralPublicLinkConfig;
}

export type ReferralPublicLinkConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly origin: string;
      readonly path: string;
    };

export type AlipayPrivateKeyType = "PKCS1" | "PKCS8";
export type AlipayEnvironment = "sandbox" | "production";

const ALIPAY_GATEWAYS: Readonly<Record<AlipayEnvironment, string>> =
  Object.freeze({
    sandbox: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
    production: "https://openapi.alipay.com/gateway.do",
  });

export interface AlipayConfig {
  readonly appId: string;
  readonly sellerId: string;
  readonly gateway: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly privateKey: string;
  readonly alipayPublicKey: string;
  readonly privateKeyType: AlipayPrivateKeyType;
}

export interface AuthCredentialConfig {
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly inviteHmacKeyring: InviteHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly csrfSigningKey: Buffer;
}

export interface DeliveryCredentialConfig {
  readonly deliveryEncKeyring: TokenHmacKeyring;
}

export type MonitorRuntimeConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly privateOrigin: string };

export type MonitorCredentialConfig = MonitorPrivateTlsCredentials;

export interface MailDispatcherRuntimeConfig {
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryDelaysMs: readonly number[];
}

export type MailRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly dispatcher: MailDispatcherRuntimeConfig;
      readonly resend: {
        readonly fromEmail: string;
        readonly requestTimeoutMs: number;
      };
    };

export interface ResendCredentialConfig {
  readonly apiKey: string;
}

const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const KEY_VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_MAIL_DISPATCH_ATTEMPTS = 10;
// Resend currently retains an idempotency key for 24 hours. The final retry
// must be scheduled before that boundary, including timer and timeout slop.
const RESEND_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

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

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  );
}

export function loadReferralPublicLinkConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnv: RuntimeEnvironment,
): ReferralPublicLinkConfig {
  const originValue = environment.REFERRAL_PUBLIC_ORIGIN;
  const pathValue = environment.REFERRAL_PUBLIC_PATH;
  if (originValue === undefined && pathValue === undefined) {
    return Object.freeze({ enabled: false });
  }
  if (
    originValue === undefined ||
    pathValue === undefined ||
    originValue.trim() !== originValue ||
    pathValue.trim() !== pathValue ||
    originValue === "" ||
    pathValue === ""
  ) {
    throw new Error("Referral public link configuration is invalid");
  }

  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("Referral public link configuration is invalid");
  }
  const loopbackHttp =
    nodeEnv !== "production" &&
    origin.protocol === "http:" &&
    isLoopbackHostname(origin.hostname);
  if (
    (origin.protocol !== "https:" && !loopbackHttp) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    originValue !== origin.origin
  ) {
    throw new Error("Referral public link configuration is invalid");
  }

  if (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*(?:\.[A-Za-z0-9_-]+)?$/.test(pathValue)) {
    throw new Error("Referral public link configuration is invalid");
  }
  const target = new URL(pathValue, `${origin.origin}/`);
  if (
    target.origin !== origin.origin ||
    target.pathname !== pathValue ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error("Referral public link configuration is invalid");
  }

  return Object.freeze({
    enabled: true,
    origin: origin.origin,
    path: pathValue,
  });
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
  const paymentEnabledValue = environment.PAYMENT_ENABLED;
  if (paymentEnabledValue !== "true" && paymentEnabledValue !== "false") {
    throw new Error("PAYMENT_ENABLED must be exactly true or false");
  }

  return Object.freeze({
    host: LOOPBACK_HOST,
    port,
    dbPath,
    nodeEnv,
    registrationEnabled: registrationEnabledValue === "true",
    paymentEnabled: paymentEnabledValue === "true",
    referralPublicLink: loadReferralPublicLinkConfig(environment, nodeEnv),
  });
}

function requireAlipayValue(
  environment: NodeJS.ProcessEnv,
  name:
    | "ALIPAY_APP_ID"
    | "ALIPAY_SELLER_ID"
    | "ALIPAY_NOTIFY_URL"
    | "ALIPAY_RETURN_URL"
    | "ALIPAY_PRIVATE_KEY_FILE"
    | "ALIPAY_PUBLIC_KEY_FILE"
    | "ALIPAY_PRIVATE_KEY_TYPE"
    | "ALIPAY_ENVIRONMENT",
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error("Alipay configuration is invalid");
  }
  return value;
}

function readAlipayKey(path: string): string {
  try {
    const value = readFileSync(resolve(path), "utf8").trim();
    if (!value) {
      throw new Error("empty key");
    }
    return value;
  } catch {
    throw new Error("Alipay configuration is invalid");
  }
}

export function loadAlipayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AlipayConfig {
  if (environment.PAYMENT_ENABLED !== "true") {
    throw new Error("Alipay configuration is disabled");
  }

  const privateKeyType = requireAlipayValue(
    environment,
    "ALIPAY_PRIVATE_KEY_TYPE",
  );
  if (privateKeyType !== "PKCS1" && privateKeyType !== "PKCS8") {
    throw new Error("Alipay configuration is invalid");
  }

  const alipayEnvironment = requireAlipayValue(
    environment,
    "ALIPAY_ENVIRONMENT",
  );
  if (
    alipayEnvironment !== "sandbox" &&
    alipayEnvironment !== "production"
  ) {
    throw new Error("Alipay configuration is invalid");
  }

  return Object.freeze({
    appId: requireAlipayValue(environment, "ALIPAY_APP_ID"),
    sellerId: requireAlipayValue(environment, "ALIPAY_SELLER_ID"),
    gateway: ALIPAY_GATEWAYS[alipayEnvironment],
    notifyUrl: requireAlipayValue(environment, "ALIPAY_NOTIFY_URL"),
    returnUrl: requireAlipayValue(environment, "ALIPAY_RETURN_URL"),
    privateKey: readAlipayKey(
      requireAlipayValue(environment, "ALIPAY_PRIVATE_KEY_FILE"),
    ),
    alipayPublicKey: readAlipayKey(
      requireAlipayValue(environment, "ALIPAY_PUBLIC_KEY_FILE"),
    ),
    privateKeyType,
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

export function loadDeliveryCredentialConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DeliveryCredentialConfig {
  const directory = environment.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) {
    throw new Error("Delivery credential configuration is invalid");
  }
  try {
    return Object.freeze({
      deliveryEncKeyring: parseKeyring(
        readCredential(directory, "delivery_payload_enc_keyring"),
      ),
    });
  } catch {
    throw new Error("Delivery credential configuration is invalid");
  }
}

export function loadMonitorRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MonitorRuntimeConfig {
  const enabled = environment.MONITOR_AUTH_PROJECTION_ENABLED;
  if (enabled === undefined || enabled === "false") {
    return Object.freeze({ enabled: false });
  }
  if (enabled !== "true") {
    throw new Error("Monitor Auth runtime configuration is invalid");
  }
  const privateOrigin = normalizeMonitorPrivateOrigin(
    environment.MONITOR_AUTH_PRIVATE_ORIGIN,
  );
  if (privateOrigin === null) {
    throw new Error("Monitor Auth runtime configuration is invalid");
  }
  return Object.freeze({ enabled: true, privateOrigin });
}

function readMonitorCredential(directory: string, name: string): Buffer {
  try {
    const value = readFileSync(resolve(directory, name));
    if (value.length < 1 || value.length > 256 * 1024) {
      throw new Error("invalid credential size");
    }
    return value;
  } catch {
    throw new Error("Monitor Auth credential configuration is invalid");
  }
}

export function loadMonitorCredentialConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MonitorCredentialConfig {
  const directory = environment.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) {
    throw new Error("Monitor Auth credential configuration is invalid");
  }
  return Object.freeze({
    caCertificate: readMonitorCredential(
      directory,
      "monitor_private_ca_certificate",
    ),
    clientCertificate: readMonitorCredential(
      directory,
      "monitor_auth_service_client_certificate",
    ),
    clientPrivateKey: readMonitorCredential(
      directory,
      "monitor_auth_service_client_private_key",
    ),
  });
}

function invalidMailRuntimeConfiguration(): Error {
  return new Error("Mail runtime configuration is invalid");
}

function requireMailRuntimeValue(
  environment: NodeJS.ProcessEnv,
  name:
    | "MAIL_DISPATCH_INTERVAL_MS"
    | "MAIL_DISPATCH_LEASE_MS"
    | "MAIL_DISPATCH_MAX_ATTEMPTS"
    | "MAIL_DISPATCH_RETRY_DELAYS_MS"
    | "RESEND_FROM_EMAIL"
    | "RESEND_REQUEST_TIMEOUT_MS",
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidMailRuntimeConfiguration();
  }
  return value;
}

function parseMailPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name:
    | "MAIL_DISPATCH_INTERVAL_MS"
    | "MAIL_DISPATCH_LEASE_MS"
    | "MAIL_DISPATCH_MAX_ATTEMPTS"
    | "RESEND_REQUEST_TIMEOUT_MS",
): number {
  const value = requireMailRuntimeValue(environment, name);
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw invalidMailRuntimeConfiguration();
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_TIMER_DELAY_MS
  ) {
    throw invalidMailRuntimeConfiguration();
  }
  return parsed;
}

function parseMailRetryDelays(
  environment: NodeJS.ProcessEnv,
  maxAttempts: number,
): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      requireMailRuntimeValue(environment, "MAIL_DISPATCH_RETRY_DELAYS_MS"),
    );
  } catch {
    throw invalidMailRuntimeConfiguration();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== maxAttempts - 1 ||
    parsed.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_TIMER_DELAY_MS,
    )
  ) {
    throw invalidMailRuntimeConfiguration();
  }
  return Object.freeze([...parsed]) as readonly number[];
}

export function loadMailRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MailRuntimeConfig {
  const enabled = environment.MAIL_DISPATCH_ENABLED;
  if (enabled !== "true" && enabled !== "false") {
    throw invalidMailRuntimeConfiguration();
  }
  if (enabled === "false") {
    return Object.freeze({ enabled: false });
  }

  const intervalMs = parseMailPositiveInteger(
    environment,
    "MAIL_DISPATCH_INTERVAL_MS",
  );
  const leaseMs = parseMailPositiveInteger(
    environment,
    "MAIL_DISPATCH_LEASE_MS",
  );
  const maxAttempts = parseMailPositiveInteger(
    environment,
    "MAIL_DISPATCH_MAX_ATTEMPTS",
  );
  if (maxAttempts > MAX_MAIL_DISPATCH_ATTEMPTS) {
    throw invalidMailRuntimeConfiguration();
  }
  const requestTimeoutMs = parseMailPositiveInteger(
    environment,
    "RESEND_REQUEST_TIMEOUT_MS",
  );
  if (requestTimeoutMs >= leaseMs) {
    throw invalidMailRuntimeConfiguration();
  }
  const retryDelaysMs = parseMailRetryDelays(environment, maxAttempts);
  const retryWindowMs = retryDelaysMs.reduce(
    (total, delay) => total + delay + requestTimeoutMs + intervalMs,
    0,
  );
  if (
    !Number.isSafeInteger(retryWindowMs) ||
    retryWindowMs >= RESEND_IDEMPOTENCY_RETENTION_MS
  ) {
    throw invalidMailRuntimeConfiguration();
  }

  let fromEmail: string;
  try {
    fromEmail = canonicalizeEmail(
      requireMailRuntimeValue(environment, "RESEND_FROM_EMAIL"),
    );
  } catch {
    throw invalidMailRuntimeConfiguration();
  }

  return Object.freeze({
    enabled: true,
    dispatcher: Object.freeze({
      intervalMs,
      leaseMs,
      maxAttempts,
      retryDelaysMs,
    }),
    resend: Object.freeze({ fromEmail, requestTimeoutMs }),
  });
}

export function loadResendCredentialConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ResendCredentialConfig {
  const directory = environment.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) {
    throw new Error("Resend credential configuration is invalid");
  }
  try {
    const apiKey = readCredential(directory, "resend_api_key");
    if (apiKey.length > 512 || !VISIBLE_ASCII_PATTERN.test(apiKey)) {
      throw new Error("invalid credential");
    }
    return Object.freeze({ apiKey });
  } catch {
    throw new Error("Resend credential configuration is invalid");
  }
}

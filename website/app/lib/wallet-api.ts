/* 钱包与续费授权客户端（NSP-WALLET-UI-WIRING-20261004）。契约取自已推送后端
   16458599 的 auth-service/src/http/wallet-routes.ts：
   - GET  /api/me/wallet                                   -> { balanceFen, currency: "CNY" }
   - GET  /api/me/services/:id/renewal-quote?period=…      -> { quote: {...} }
   - GET  /api/me/services/:id/renewal-consent             -> { consent: {...} }
   - PUT  /api/me/services/:id/renewal-consent             body 仅 { period, expectedRevision, enabled } -> { revision }
   错误统一 { error: { code } }。所有请求同源携带 Session Cookie；写操作携带 Session 绑定的 CSRF。
   价格、报价 key、到期时间只由服务端给出，浏览器从不提交。:id 是服务端 services.id；
   买家服务列表目前不返回该字段，调用方不得用 orderRef 或其他字段推算。 */

export type BillingPeriod = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
export const BILLING_PERIODS: readonly BillingPeriod[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];

export interface WalletBalance {
  readonly balanceFen: number;
  readonly currency: "CNY";
}

export interface RenewalQuote {
  readonly key: string;
  readonly priceFen: number;
  readonly currency: "CNY";
  readonly durationId: string;
  readonly period: BillingPeriod;
  readonly previousEndsAt: string | null;
  readonly newEndsAt: string;
}

export interface RenewalConsent {
  /** 已知取值：DISABLED（含从未设置）、ENABLED、RECONSENT_REQUIRED；其余值原样保留，按未开启处理。 */
  readonly state: string;
  readonly revision: number;
  readonly period: BillingPeriod | null;
  readonly priceFen: number | null;
  readonly durationId: string | null;
  readonly updatedAt: string | null;
}

export class WalletApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "WalletApiError";
    this.code = code;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function isPeriod(value: unknown): value is BillingPeriod {
  return BILLING_PERIODS.includes(value as BillingPeriod);
}

function invalid(): never {
  throw new WalletApiError("invalid_response");
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return null;
  return value.error.code;
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new WalletApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new WalletApiError(response.ok ? "invalid_response" : "request_failed", response.status);
  }
  if (!response.ok) throw new WalletApiError(errorCode(value) ?? "request_failed", response.status);
  return value;
}

function servicePath(serviceId: number): string {
  if (!Number.isSafeInteger(serviceId) || serviceId <= 0) throw new WalletApiError("not_found", 404);
  return `/api/me/services/${serviceId}`;
}

function parseWallet(value: unknown): WalletBalance {
  if (!isRecord(value) || !isNonNegativeInteger(value.balanceFen) || value.currency !== "CNY") invalid();
  return { balanceFen: value.balanceFen, currency: "CNY" };
}

function parseQuote(value: unknown): RenewalQuote {
  const quote = isRecord(value) ? value.quote : undefined;
  if (
    !isRecord(quote) ||
    typeof quote.key !== "string" ||
    quote.key.length === 0 ||
    !isNonNegativeInteger(quote.priceFen) ||
    quote.currency !== "CNY" ||
    typeof quote.durationId !== "string" ||
    quote.durationId.length === 0 ||
    !isPeriod(quote.period) ||
    !(quote.previousEndsAt === null || isInstant(quote.previousEndsAt)) ||
    !isInstant(quote.newEndsAt)
  ) {
    invalid();
  }
  return {
    key: quote.key,
    priceFen: quote.priceFen,
    currency: "CNY",
    durationId: quote.durationId,
    period: quote.period,
    previousEndsAt: quote.previousEndsAt as string | null,
    newEndsAt: quote.newEndsAt,
  };
}

function parseConsent(value: unknown): RenewalConsent {
  const consent = isRecord(value) ? value.consent : undefined;
  if (
    !isRecord(consent) ||
    typeof consent.state !== "string" ||
    consent.state.length === 0 ||
    !isNonNegativeInteger(consent.revision) ||
    !(consent.period === null || isPeriod(consent.period)) ||
    !(consent.priceFen === null || isNonNegativeInteger(consent.priceFen)) ||
    !(consent.durationId === null || typeof consent.durationId === "string") ||
    // 从未设置过授权时服务端返回 updatedAt: ""（candidate.ts readRenewalConsent），视为无记录。
    !(consent.updatedAt === null || consent.updatedAt === "" || isInstant(consent.updatedAt))
  ) {
    invalid();
  }
  return {
    state: consent.state,
    revision: consent.revision,
    period: consent.period as BillingPeriod | null,
    priceFen: consent.priceFen as number | null,
    durationId: consent.durationId as string | null,
    updatedAt: consent.updatedAt === "" ? null : (consent.updatedAt as string | null),
  };
}

export async function getMyWallet(signal?: AbortSignal): Promise<WalletBalance> {
  return parseWallet(await requestJson("/api/me/wallet", { method: "GET", headers: { Accept: "application/json" } }, signal));
}

export async function getRenewalQuote(serviceId: number, period: BillingPeriod, signal?: AbortSignal): Promise<RenewalQuote> {
  if (!isPeriod(period)) throw new WalletApiError("invalid_request", 400);
  const url = `${servicePath(serviceId)}/renewal-quote?period=${period}`;
  return parseQuote(await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal));
}

export async function getRenewalConsent(serviceId: number, signal?: AbortSignal): Promise<RenewalConsent> {
  const url = `${servicePath(serviceId)}/renewal-consent`;
  return parseConsent(await requestJson(url, { method: "GET", headers: { Accept: "application/json" } }, signal));
}

/** 只提交 { period, expectedRevision, enabled }；返回服务端新的 revision。 */
export async function putRenewalConsent(
  csrfToken: string,
  serviceId: number,
  input: { readonly period: BillingPeriod; readonly expectedRevision: number; readonly enabled: boolean },
): Promise<number> {
  if (!isPeriod(input.period) || !isNonNegativeInteger(input.expectedRevision) || typeof input.enabled !== "boolean") {
    throw new WalletApiError("invalid_request", 400);
  }
  const value = await requestJson(`${servicePath(serviceId)}/renewal-consent`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ period: input.period, expectedRevision: input.expectedRevision, enabled: input.enabled }),
  });
  if (!isRecord(value) || !isNonNegativeInteger(value.revision)) invalid();
  return value.revision;
}

/** 金额一律按分精确显示两位小数：0 分显示 ¥0.00（真实零余额），不是占位。 */
export function formatWalletFen(balanceFen: number): string {
  const yuan = Math.trunc(balanceFen / 100);
  const fen = String(balanceFen % 100).padStart(2, "0");
  return `¥${yuan.toLocaleString("en-US")}.${fen}`;
}

export type WalletLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly wallet: WalletBalance }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly code: string };
